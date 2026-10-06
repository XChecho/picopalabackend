import { INestApplication } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { createApp } from "./utils/app";
import {
  API,
  PASSWORD,
  bearer,
  containsText,
  createDb,
  freshIp,
  http,
  loginUser,
  registerUser,
  truncateAll,
  uniqueName,
} from "./utils/helpers";

describe("Auth (e2e)", () => {
  let app: INestApplication;
  let db: PrismaClient;

  beforeAll(async () => {
    db = createDb();
    await truncateAll(db);
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  describe("POST /auth/register", () => {
    it("creates the player and returns tokens without leaking the hash", async () => {
      const username = uniqueName("reg");
      const res = await http(app)
        .post(`${API}/auth/register`)
        .set("X-Forwarded-For", freshIp())
        .send({
          username,
          email: `${username}@Example.com`,
          password: PASSWORD,
        });

      expect(res.status).toBe(201);
      expect(res.body.statusCode).toBe(201);
      expect(typeof res.body.data.accessToken).toBe("string");
      expect(typeof res.body.data.refreshToken).toBe("string");
      expect(res.body.data.player).toMatchObject({
        username,
        email: `${username}@example.com`,
        elo: 1000,
        rank: "PLATA",
        language: "EN",
      });
      expect(containsText(res.body, "passwordHash")).toBe(false);
      expect(containsText(res.body, PASSWORD)).toBe(false);

      const row = await db.player.findUniqueOrThrow({ where: { username } });
      expect(row.passwordHash).toBeTruthy();
      expect(row.passwordHash).not.toBe(PASSWORD);
    });

    it("returns an identical generic 409 for duplicate username (any case) and duplicate email", async () => {
      const username = uniqueName("dup");
      await registerUser(app, { username });

      const byUsername = await http(app)
        .post(`${API}/auth/register`)
        .set("X-Forwarded-For", freshIp())
        .send({
          username: username.toUpperCase(),
          email: "other1@example.com",
          password: PASSWORD,
        });
      const byEmail = await http(app)
        .post(`${API}/auth/register`)
        .set("X-Forwarded-For", freshIp())
        .send({
          username: uniqueName("dpe"),
          email: `${username.toLowerCase()}@EXAMPLE.com`,
          password: PASSWORD,
        });

      expect(byUsername.status).toBe(409);
      expect(byEmail.status).toBe(409);
      expect(byUsername.body.message).toBe("Username or email already in use");
      expect(byEmail.body.message).toBe(byUsername.body.message);
    });

    it.each([
      ["username too short", { username: "ab" }],
      ["username with symbols", { username: "bad_name!" }],
      ["username too long", { username: "a".repeat(21) }],
      ["invalid email", { email: "not-an-email" }],
      ["password too short", { password: "short" }],
      ["password too long", { password: "x".repeat(73) }],
      ["unknown language", { language: "fr" }],
      ["unknown platform", { platform: "WINDOWS" }],
      ["non-whitelisted field", { isAdmin: true }],
    ])("rejects %s with 400", async (_name, patch) => {
      const username = uniqueName("val");
      const res = await http(app)
        .post(`${API}/auth/register`)
        .set("X-Forwarded-For", freshIp())
        .send({
          username,
          email: `${username}@example.com`,
          password: PASSWORD,
          ...patch,
        });

      expect(res.status).toBe(400);
      expect(res.body.statusCode).toBe(400);
      expect(res.body.stack).toBeUndefined();
    });

    it("rejects an empty body with 400", async () => {
      const res = await http(app)
        .post(`${API}/auth/register`)
        .set("X-Forwarded-For", freshIp())
        .send({});
      expect(res.status).toBe(400);
    });
  });

  describe("POST /auth/login", () => {
    it("logs in by username case-insensitively", async () => {
      const user = await registerUser(app);
      for (const variant of [
        user.username,
        user.username.toUpperCase(),
        user.username.toLowerCase(),
      ]) {
        const res = await loginUser(app, variant);
        expect(res.status).toBe(200);
        expect(res.body.data.player.id).toBe(user.id);
        expect(containsText(res.body, "passwordHash")).toBe(false);
      }
    });

    it("returns the same 401 for wrong password and unknown user", async () => {
      const user = await registerUser(app);
      const wrongPassword = await loginUser(
        app,
        user.username,
        "WrongPassword1",
      );
      const unknown = await loginUser(app, "nobodyhere", PASSWORD);

      expect(wrongPassword.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(unknown.body.message).toBe(wrongPassword.body.message);
      expect(containsText(wrongPassword.body, "passwordHash")).toBe(false);
    });

    it("rejects malformed payloads with 400", async () => {
      const res = await http(app)
        .post(`${API}/auth/login`)
        .set("X-Forwarded-For", freshIp())
        .send({ username: "ab", password: "short" });
      expect(res.status).toBe(400);
    });

    it("rejects a login for a soft-deleted player", async () => {
      const user = await registerUser(app);
      await db.player.update({
        where: { id: user.id },
        data: { deletedAt: new Date() },
      });
      const res = await loginUser(app, user.username);
      expect(res.status).toBe(401);
    });
  });

  describe("POST /auth/refresh", () => {
    const refresh = (accessOrRefresh: string, body: string) =>
      http(app)
        .post(`${API}/auth/refresh`)
        .set("X-Forwarded-For", freshIp())
        .set(bearer(accessOrRefresh))
        .send({ refreshToken: body });

    it("rotates the refresh token and revokes the whole family on reuse", async () => {
      const user = await registerUser(app);
      const first = user.refreshToken;

      const rotated = await refresh(first, first);
      expect(rotated.status).toBe(200);
      const second: string = rotated.body.data.refreshToken;
      expect(second).not.toBe(first);
      expect(typeof rotated.body.data.accessToken).toBe("string");
      expect(containsText(rotated.body, "passwordHash")).toBe(false);

      // The new access token must work.
      const me = await http(app)
        .get(`${API}/player/me`)
        .set(bearer(rotated.body.data.accessToken));
      expect(me.status).toBe(200);

      // Reusing the old token is rejected...
      const reuse = await refresh(first, first);
      expect(reuse.status).toBe(401);

      // ...and the family is dead: the legitimately rotated token stops working too.
      const afterTheft = await refresh(second, second);
      expect(afterTheft.status).toBe(401);

      const sessions = await db.session.findMany({
        where: { playerId: user.id },
      });
      expect(sessions.length).toBe(2);
      expect(sessions.every((s) => s.revokedAt !== null)).toBe(true);
      expect(new Set(sessions.map((s) => s.familyId)).size).toBe(1);
    });

    it("does not accept an access token as refresh bearer", async () => {
      const user = await registerUser(app);
      const res = await refresh(user.accessToken, user.refreshToken);
      expect(res.status).toBe(401);
    });

    it("rejects a body refresh token that is not a stored session", async () => {
      const a = await registerUser(app);
      const b = await registerUser(app);
      // Bearer of A, body token of B: the session belongs to another player.
      const res = await refresh(a.refreshToken, b.refreshToken);
      expect(res.status).toBe(401);
      // B's session must remain usable.
      const ok = await refresh(b.refreshToken, b.refreshToken);
      expect(ok.status).toBe(200);
    });

    it("rejects missing/garbage tokens", async () => {
      const noAuth = await http(app)
        .post(`${API}/auth/refresh`)
        .set("X-Forwarded-For", freshIp())
        .send({ refreshToken: "abc" });
      expect(noAuth.status).toBe(401);

      const garbage = await refresh(
        "garbage.token.value",
        "garbage.token.value",
      );
      expect(garbage.status).toBe(401);
    });

    it("does not refresh a soft-deleted player", async () => {
      const user = await registerUser(app);
      await db.player.update({
        where: { id: user.id },
        data: { deletedAt: new Date() },
      });
      const res = await refresh(user.refreshToken, user.refreshToken);
      expect(res.status).toBe(401);
    });
  });

  describe("POST /auth/logout", () => {
    it("revokes the session family so the refresh token stops working", async () => {
      const user = await registerUser(app);

      const out = await http(app)
        .post(`${API}/auth/logout`)
        .set(bearer(user.accessToken))
        .send({ refreshToken: user.refreshToken });
      expect(out.status).toBe(200);
      expect(out.body.data.message).toBe("Logged out successfully");

      const res = await http(app)
        .post(`${API}/auth/refresh`)
        .set("X-Forwarded-For", freshIp())
        .set(bearer(user.refreshToken))
        .send({ refreshToken: user.refreshToken });
      expect(res.status).toBe(401);
    });

    it("requires authentication and a body", async () => {
      const noAuth = await http(app)
        .post(`${API}/auth/logout`)
        .send({ refreshToken: "x" });
      expect(noAuth.status).toBe(401);

      const user = await registerUser(app);
      const noBody = await http(app)
        .post(`${API}/auth/logout`)
        .set(bearer(user.accessToken))
        .send({});
      expect(noBody.status).toBe(400);
    });

    it("cannot revoke another player's session", async () => {
      const a = await registerUser(app);
      const b = await registerUser(app);
      const out = await http(app)
        .post(`${API}/auth/logout`)
        .set(bearer(a.accessToken))
        .send({ refreshToken: b.refreshToken });
      expect(out.status).toBe(200);

      const stillValid = await http(app)
        .post(`${API}/auth/refresh`)
        .set("X-Forwarded-For", freshIp())
        .set(bearer(b.refreshToken))
        .send({ refreshToken: b.refreshToken });
      expect(stillValid.status).toBe(200);
    });
  });

  describe("access token validation", () => {
    it("rejects an access token whose player has deletedAt set", async () => {
      const user = await registerUser(app);
      const before = await http(app)
        .get(`${API}/player/me`)
        .set(bearer(user.accessToken));
      expect(before.status).toBe(200);

      await db.player.update({
        where: { id: user.id },
        data: { deletedAt: new Date() },
      });

      const after = await http(app)
        .get(`${API}/player/me`)
        .set(bearer(user.accessToken));
      expect(after.status).toBe(401);
    });

    it("rejects missing, malformed and refresh-signed tokens", async () => {
      const user = await registerUser(app);
      expect((await http(app).get(`${API}/player/me`)).status).toBe(401);
      expect(
        (await http(app).get(`${API}/player/me`).set(bearer("nope"))).status,
      ).toBe(401);
      expect(
        (await http(app).get(`${API}/player/me`).set(bearer(user.refreshToken)))
          .status,
      ).toBe(401);
    });
  });

  describe("rate limiting", () => {
    // Uses its own app instance: throttler storage lives in memory per app.
    let limited: INestApplication;
    beforeAll(async () => {
      limited = await createApp();
    });
    afterAll(async () => {
      await limited.close();
    });

    it("limits register to 5/min per client and answers 429 on the 6th", async () => {
      const ip = "203.0.113.10";
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const username = uniqueName("thr");
        const res = await http(limited)
          .post(`${API}/auth/register`)
          .set("X-Forwarded-For", ip)
          .send({
            username,
            email: `${username}@example.com`,
            password: PASSWORD,
          });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);

      // A different client IP is unaffected.
      const other = await http(limited)
        .post(`${API}/auth/register`)
        .set("X-Forwarded-For", "203.0.113.11")
        .send({
          username: uniqueName("thr"),
          email: `${uniqueName("thr")}@example.com`,
          password: PASSWORD,
        });
      expect(other.status).toBe(201);
    });

    it("limits login to 10/min per client and answers 429 on the 11th", async () => {
      const ip = "203.0.113.20";
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const res = await http(limited)
          .post(`${API}/auth/login`)
          .set("X-Forwarded-For", ip)
          .send({ username: "ghostuser", password: PASSWORD });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    });
  });
});

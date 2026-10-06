import { INestApplication } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { createApp } from "./utils/app";
import {
  API,
  bearer,
  containsText,
  createDb,
  http,
  registerUser,
  truncateAll,
} from "./utils/helpers";
import { playAiUntilWin } from "./utils/play";

describe("Player (e2e)", () => {
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

  describe("GET /player/me", () => {
    it("requires authentication", async () => {
      expect((await http(app).get(`${API}/player/me`)).status).toBe(401);
    });

    it("returns the profile without sensitive fields", async () => {
      const user = await registerUser(app);
      const res = await http(app)
        .get(`${API}/player/me`)
        .set(bearer(user.accessToken));

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        id: user.id,
        username: user.username,
        email: user.email,
        avatarUrl: null,
        language: "EN",
        elo: 1000,
        rank: "PLATA",
        createdAt: expect.any(String),
      });
      expect(containsText(res.body, "passwordHash")).toBe(false);
    });
  });

  describe("PATCH /player/me", () => {
    it("updates language and a cloudinary https avatar", async () => {
      const user = await registerUser(app);
      const avatar =
        "https://res.cloudinary.com/demo/image/upload/v1/avatar.png";
      const res = await http(app)
        .patch(`${API}/player/me`)
        .set(bearer(user.accessToken))
        .send({ avatar, language: "es" });

      expect(res.status).toBe(200);
      expect(res.body.data.avatarUrl).toBe(avatar);
      expect(res.body.data.language).toBe("ES");

      const me = await http(app)
        .get(`${API}/player/me`)
        .set(bearer(user.accessToken));
      expect(me.body.data.avatarUrl).toBe(avatar);
    });

    it.each([
      ["http scheme", "http://res.cloudinary.com/demo/a.png"],
      ["foreign host", "https://evil.example.com/a.png"],
      [
        "host suffix trick",
        "https://res.cloudinary.com.evil.example.com/a.png",
      ],
      ["javascript scheme", "javascript:alert(1)"],
      ["no protocol", "res.cloudinary.com/demo/a.png"],
    ])("rejects avatar with %s (400)", async (_name, avatar) => {
      const user = await registerUser(app);
      const res = await http(app)
        .patch(`${API}/player/me`)
        .set(bearer(user.accessToken))
        .send({ avatar });
      expect(res.status).toBe(400);

      const me = await http(app)
        .get(`${API}/player/me`)
        .set(bearer(user.accessToken));
      expect(me.body.data.avatarUrl).toBeNull();
    });

    it("rejects non-whitelisted fields (cannot self-assign elo) and bad values", async () => {
      const user = await registerUser(app);
      for (const body of [
        { elo: 3000 },
        { rank: "DIAMANTE" },
        { language: "fr" },
        { username: "a!" },
      ]) {
        const res = await http(app)
          .patch(`${API}/player/me`)
          .set(bearer(user.accessToken))
          .send(body);
        expect(res.status).toBe(400);
      }
      const me = await http(app)
        .get(`${API}/player/me`)
        .set(bearer(user.accessToken));
      expect(me.body.data.elo).toBe(1000);
    });

    it("changes username and rejects a taken one (case-insensitive) with 409", async () => {
      const a = await registerUser(app);
      const b = await registerUser(app);

      const taken = await http(app)
        .patch(`${API}/player/me`)
        .set(bearer(b.accessToken))
        .send({ username: a.username.toUpperCase() });
      expect(taken.status).toBe(409);

      const renamed = `${b.username}x`.slice(0, 20);
      const ok = await http(app)
        .patch(`${API}/player/me`)
        .set(bearer(b.accessToken))
        .send({ username: renamed });
      expect(ok.status).toBe(200);
      expect(ok.body.data.username).toBe(renamed);
    });
  });

  describe("stats, matches and elo-history", () => {
    it("are empty/zero for a new player", async () => {
      const user = await registerUser(app);
      const auth = bearer(user.accessToken);

      const stats = await http(app).get(`${API}/player/me/stats`).set(auth);
      expect(stats.status).toBe(200);
      expect(stats.body.data).toMatchObject({
        totalGames: 0,
        wins: 0,
        losses: 0,
        draws: 0,
        currentStreak: 0,
        bestStreak: 0,
        bestAttempts: null,
        totalAttempts: 0,
        totalPicos: 0,
        totalPalas: 0,
        totalDurationSec: 0,
        avgTimePerGame: 0,
      });
      expect(
        stats.body.data.byMode.map((m: { mode: string }) => m.mode).sort(),
      ).toEqual(["GLOBAL", "PRIVATE", "VERSUS_AI"]);

      const matches = await http(app).get(`${API}/player/me/matches`).set(auth);
      expect(matches.status).toBe(200);
      expect(matches.body.data).toEqual({
        matches: [],
        total: 0,
        limit: 20,
        offset: 0,
      });

      const elo = await http(app).get(`${API}/player/me/elo-history`).set(auth);
      expect(elo.status).toBe(200);
      expect(elo.body.data).toEqual([]);
    });

    it("reflect a finished match; unranked AI games do not touch elo-history", async () => {
      const user = await registerUser(app);
      const outcome = await playAiUntilWin(app, user);
      const auth = bearer(user.accessToken);

      const stats = await http(app).get(`${API}/player/me/stats`).set(auth);
      expect(stats.body.data.totalGames).toBe(1);
      expect(stats.body.data.wins).toBe(1);
      expect(stats.body.data.bestAttempts).toBe(outcome.moves.length);

      const history = await http(app).get(`${API}/player/me/matches`).set(auth);
      if (history.status !== 200)
        console.log(history.status, JSON.stringify(history.body));
      expect(history.body.data.total).toBe(1);
      expect(history.body.data.matches[0].id).toBe(outcome.matchId);
      expect(history.body.data.matches[0].status).toBe("FINISHED");

      const elo = await http(app).get(`${API}/player/me/elo-history`).set(auth);
      expect(elo.body.data).toEqual([]);

      const me = await http(app).get(`${API}/player/me`).set(auth);
      expect(me.body.data.elo).toBe(1000);
    });

    it("validates pagination and filters", async () => {
      const user = await registerUser(app);
      const auth = bearer(user.accessToken);

      expect(
        (await http(app).get(`${API}/player/me/matches?mode=NOPE`).set(auth))
          .status,
      ).toBe(400);
      expect(
        (await http(app).get(`${API}/player/me/matches?status=NOPE`).set(auth))
          .status,
      ).toBe(400);

      const clamped = await http(app)
        .get(`${API}/player/me/matches?limit=100000&offset=-5`)
        .set(auth);
      expect(clamped.status).toBe(200);
      expect(clamped.body.data.limit).toBe(100);
      expect(clamped.body.data.offset).toBe(0);

      const garbage = await http(app)
        .get(`${API}/player/me/matches?limit=abc`)
        .set(auth);
      expect(garbage.status).toBe(200);
      expect(garbage.body.data.limit).toBe(20);

      const elo = await http(app)
        .get(`${API}/player/me/elo-history?limit=9999`)
        .set(auth);
      expect(elo.status).toBe(200);
    });
  });

  describe("PATCH /player/me/push-token", () => {
    it("registers a token using the last session platform and validates input", async () => {
      const user = await registerUser(app);
      const auth = bearer(user.accessToken);

      const ok = await http(app)
        .patch(`${API}/player/me/push-token`)
        .set(auth)
        .send({ expoPushToken: "ExponentPushToken[e2e-token]" });
      expect(ok.status).toBe(200);

      const device = await db.device.findUniqueOrThrow({
        where: { pushToken: "ExponentPushToken[e2e-token]" },
      });
      expect(device.playerId).toBe(user.id);
      expect(device.platform).toBe("WEB");

      expect(
        (
          await http(app)
            .patch(`${API}/player/me/push-token`)
            .set(auth)
            .send({})
        ).status,
      ).toBe(400);
    });
  });
});

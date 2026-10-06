import { INestApplication } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { createApp } from "./utils/app";
import { FakeCaptchaService } from "./utils/fake-captcha";
import { CaptchaService } from "../src/captcha/captcha.service";
import {
  API,
  BFF_KEY,
  PASSWORD,
  bearer,
  createDb,
  freshIp,
  http,
  truncateAll,
  uniqueName,
} from "./utils/helpers";

const creds = (prefix: string) => {
  const username = uniqueName(prefix);
  return { username, email: `${username}@example.com`, password: PASSWORD };
};

describe("Web vs mobile auth (e2e)", () => {
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

  const webRegister = (body: Record<string, unknown>, ip = freshIp()) =>
    http(app)
      .post(`${API}/web/auth/register`)
      .set("X-Forwarded-For", ip)
      .send(body);
  const mobileRegister = (body: Record<string, unknown>, ip = freshIp()) =>
    http(app)
      .post(`${API}/mobile/auth/register`)
      .set("X-Forwarded-For", ip)
      .send(body);

  describe("web captcha on register", () => {
    it("400 without captchaToken", async () => {
      expect((await webRegister(creds("wc"))).status).toBe(400);
    });

    it("403 with a rejected token and no player is created", async () => {
      const c = creds("wc");
      const res = await webRegister({ ...c, captchaToken: "bad-token" });
      expect(res.status).toBe(403);
      expect(res.body.message).toBe("Captcha verification failed");
      expect(await db.player.count({ where: { username: c.username } })).toBe(
        0,
      );
    });

    it("201 with a valid token", async () => {
      expect(
        (await webRegister({ ...creds("wc"), captchaToken: "ok-token" }))
          .status,
      ).toBe(201);
    });

    it("rejects a client-declared platform on web (400)", async () => {
      const res = await webRegister({
        ...creds("wp"),
        captchaToken: "ok-token",
        platform: "IOS",
      });
      expect(res.status).toBe(400);
    });

    it("web login needs no captcha", async () => {
      const c = creds("wl");
      await webRegister({ ...c, captchaToken: "ok-token" }).expect(201);
      const res = await http(app)
        .post(`${API}/web/auth/login`)
        .set("X-Forwarded-For", freshIp())
        .send({ username: c.username, password: c.password });
      expect(res.status).toBe(200);
    });

    it("forwards the BFF client IP to the captcha verifier only with a valid key", async () => {
      const fake = app.get(CaptchaService) as unknown as FakeCaptchaService;
      fake.calls.length = 0;
      await http(app)
        .post(`${API}/web/auth/register`)
        .set("X-Forwarded-For", freshIp())
        .set("X-BFF-Key", BFF_KEY)
        .set("X-Client-IP", "203.0.113.55")
        .send({ ...creds("ip"), captchaToken: "ok-token" })
        .expect(201);
      await http(app)
        .post(`${API}/web/auth/register`)
        .set("X-Forwarded-For", "192.0.2.77")
        .set("X-Client-IP", "203.0.113.56")
        .send({ ...creds("ip"), captchaToken: "ok-token" })
        .expect(201);
      expect(fake.calls.map((c) => c.remoteIp)).toEqual([
        "203.0.113.55",
        "192.0.2.77",
      ]);
    });
  });

  describe("mobile", () => {
    it.each(["IOS", "ANDROID"])(
      "register + login with platform %s and no captcha",
      async (platform) => {
        const c = creds("mb");
        const reg = await mobileRegister({ ...c, platform });
        expect(reg.status).toBe(201);
        const login = await http(app)
          .post(`${API}/mobile/auth/login`)
          .set("X-Forwarded-For", freshIp())
          .send({ username: c.username, password: c.password, platform });
        expect(login.status).toBe(200);
      },
    );

    it("rejects platform WEB, unknown and missing platform with 400", async () => {
      for (const platform of ["WEB", "WINDOWS", undefined]) {
        expect(
          (await mobileRegister({ ...creds("mx"), platform })).status,
        ).toBe(400);
        const login = await http(app)
          .post(`${API}/mobile/auth/login`)
          .set("X-Forwarded-For", freshIp())
          .send({ username: "someone", password: PASSWORD, platform });
        expect(login.status).toBe(400);
      }
    });

    it("does not accept a captchaToken field (whitelist)", async () => {
      const res = await mobileRegister({
        ...creds("mx"),
        platform: "IOS",
        captchaToken: "ok-token",
      });
      expect(res.status).toBe(400);
    });

    it("refresh and logout work under /mobile/auth", async () => {
      const reg = await mobileRegister({ ...creds("mr"), platform: "ANDROID" });
      const { accessToken, refreshToken } = reg.body.data;
      const refreshed = await http(app)
        .post(`${API}/mobile/auth/refresh`)
        .set("X-Forwarded-For", freshIp())
        .set(bearer(refreshToken))
        .send({ refreshToken });
      expect(refreshed.status).toBe(200);
      const out = await http(app)
        .post(`${API}/mobile/auth/logout`)
        .set(bearer(accessToken))
        .send({ refreshToken: refreshed.body.data.refreshToken });
      expect(out.status).toBe(200);
    });
  });

  describe("session platform is decided by the controller", () => {
    it("web => WEB, mobile => IOS/ANDROID; refresh keeps the platform", async () => {
      const web = await webRegister({
        ...creds("sp"),
        captchaToken: "ok-token",
      });
      const ios = await mobileRegister({ ...creds("sp"), platform: "IOS" });
      const droid = await mobileRegister({
        ...creds("sp"),
        platform: "ANDROID",
      });

      const platformOf = async (playerId: string) =>
        (await db.session.findMany({ where: { playerId } })).map(
          (s) => s.platform,
        );

      expect(await platformOf(web.body.data.player.id)).toEqual(["WEB"]);
      expect(await platformOf(ios.body.data.player.id)).toEqual(["IOS"]);
      expect(await platformOf(droid.body.data.player.id)).toEqual(["ANDROID"]);

      const { refreshToken } = ios.body.data;
      await http(app)
        .post(`${API}/mobile/auth/refresh`)
        .set("X-Forwarded-For", freshIp())
        .set(bearer(refreshToken))
        .send({ refreshToken })
        .expect(200);
      expect(await platformOf(ios.body.data.player.id)).toEqual(["IOS", "IOS"]);
    });
  });

  describe("legacy /auth/* routes are gone", () => {
    it.each(["register", "login", "refresh", "logout"])(
      "POST /auth/%s => 404",
      async (route) => {
        const res = await http(app)
          .post(`${API}/auth/${route}`)
          .set("X-Forwarded-For", freshIp())
          .send({});
        expect(res.status).toBe(404);
      },
    );
  });

  describe("rate limiting per route and real client IP", () => {
    let limited: INestApplication;
    beforeAll(async () => {
      limited = await createApp();
    });
    afterAll(async () => {
      await limited.close();
    });

    const mobileReg = (ip: string, headers: Record<string, string> = {}) => {
      const c = creds("rl");
      return http(limited)
        .post(`${API}/mobile/auth/register`)
        .set("X-Forwarded-For", ip)
        .set(headers)
        .send({ ...c, platform: "IOS" });
    };

    it("mobile register: 3/min, 429 on the 4th", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++)
        statuses.push((await mobileReg("203.0.113.100")).status);
      expect(statuses).toEqual([201, 201, 201, 429]);
    });

    it("mobile login: 10/min, 429 on the 11th", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++) {
        const res = await http(limited)
          .post(`${API}/mobile/auth/login`)
          .set("X-Forwarded-For", "203.0.113.101")
          .send({ username: "ghostuser", password: PASSWORD, platform: "IOS" });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    });

    it("refresh: 30/min, 429 on the 31st (web)", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 31; i++) {
        const res = await http(limited)
          .post(`${API}/web/auth/refresh`)
          .set("X-Forwarded-For", "203.0.113.102")
          .send({ refreshToken: "x" });
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
      expect(statuses[30]).toBe(429);
    });

    it("with a valid X-BFF-Key, distinct X-Client-IP values do not share quota", async () => {
      const proxy = "198.51.100.200"; // same socket/XFF peer for everyone (the BFF)
      const via = (clientIp: string) =>
        mobileReg(proxy, { "X-BFF-Key": BFF_KEY, "X-Client-IP": clientIp });

      const a: number[] = [];
      for (let i = 0; i < 4; i++) a.push((await via("203.0.113.201")).status);
      expect(a).toEqual([201, 201, 201, 429]);

      // A different real client behind the same BFF still has its own quota.
      expect((await via("203.0.113.202")).status).toBe(201);
      // IPv6 clients are tracked separately too.
      expect((await via("2001:db8::1")).status).toBe(201);
    });

    it("without a valid key, X-Client-IP is ignored (cannot dodge or poison quotas)", async () => {
      const peer = "198.51.100.210";
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push(
          (await mobileReg(peer, { "X-Client-IP": `203.0.113.${220 + i}` }))
            .status,
        );
      }
      expect(statuses).toEqual([201, 201, 201, 429]);

      const wrongKey: number[] = [];
      for (let i = 0; i < 4; i++) {
        wrongKey.push(
          (
            await mobileReg("198.51.100.211", {
              "X-BFF-Key": `${BFF_KEY}x`,
              "X-Client-IP": `203.0.113.${230 + i}`,
            })
          ).status,
        );
      }
      expect(wrongKey).toEqual([201, 201, 201, 429]);
    });

    it("an invalid X-Client-IP with a valid key falls back to the peer IP", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        statuses.push(
          (
            await mobileReg("198.51.100.220", {
              "X-BFF-Key": BFF_KEY,
              "X-Client-IP": "not-an-ip",
            })
          ).status,
        );
      }
      expect(statuses).toEqual([201, 201, 201, 429]);
    });
  });
});

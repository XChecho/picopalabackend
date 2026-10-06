import { createHash } from "crypto";
import { INestApplication } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { createApp } from "./utils/app";
import {
  API,
  BFF_KEY,
  containsText,
  createDb,
  freshIp,
  http,
  truncateAll,
} from "./utils/helpers";

const mkPlayer = (
  db: PrismaClient,
  username: string,
  elo: number,
  extra: Partial<Prisma.PlayerUncheckedCreateInput> = {},
) =>
  db.player.create({
    data: {
      username,
      email: `${username.toLowerCase()}@example.com`,
      passwordHash: "x".repeat(60),
      elo,
      ...extra,
    },
  });

const mkStats = (
  db: PrismaClient,
  playerId: string,
  games: number,
  wins: number,
) =>
  db.playerStats.create({
    data: { playerId, mode: "VERSUS_AI", games, wins, losses: games - wins },
  });

const payload = {
  name: "  Ada   Lovelace ",
  email: " Ada@Example.COM ",
  subject: "Hello    there",
  message: "Line one\r\n\r\n\r\n\r\nLine   two  ",
  captchaToken: "ok-token",
};

describe("Public endpoints (e2e)", () => {
  let app: INestApplication;
  let db: PrismaClient;

  beforeAll(async () => {
    db = createDb();
    await truncateAll(db);

    // Fixtures must exist before the app starts: leaderboard/stats are cached 60s per instance.
    const top = await mkPlayer(db, "TopDog", 1800, {
      avatarUrl: "https://res.cloudinary.com/demo/top.png",
    });
    const mid = await mkPlayer(db, "MidCat", 1400);
    const low = await mkPlayer(db, "LowBird", 900);
    const tie = await mkPlayer(db, "TieFish", 1400);
    const idle = await mkPlayer(db, "NoGames", 2500);
    const gone = await mkPlayer(db, "GoneUser", 3000, {
      deletedAt: new Date(),
    });
    await mkStats(db, top.id, 10, 9);
    await mkStats(db, mid.id, 4, 2);
    await mkStats(db, low.id, 3, 0);
    await mkStats(db, tie.id, 2, 1);
    await mkStats(db, gone.id, 5, 5);
    await db.playerStats.create({
      data: { playerId: top.id, mode: "PRIVATE", games: 2, wins: 1, losses: 1 },
    });
    await db.playerStats.create({
      data: { playerId: idle.id, mode: "VERSUS_AI", games: 0 },
    });

    await db.match.create({
      data: {
        mode: "VERSUS_AI",
        status: "FINISHED",
        finishedAt: new Date(),
        startedAt: new Date(),
      },
    });
    await db.match.create({
      data: {
        mode: "VERSUS_AI",
        status: "FINISHED",
        finishedAt: new Date(Date.now() - 3 * 86_400_000),
        startedAt: new Date(Date.now() - 3 * 86_400_000),
      },
    });
    await db.match.create({
      data: { mode: "VERSUS_AI", status: "PLAYING", startedAt: new Date() },
    });

    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  describe("GET /health", () => {
    it("returns ok without authentication", async () => {
      const res = await http(app).get(`${API}/health`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ status: "ok" });
    });

    it("is exempt from throttling", async () => {
      const statuses = await Promise.all(
        Array.from({ length: 40 }, () =>
          http(app).get(`${API}/health`).set("X-Forwarded-For", "198.51.100.1"),
        ),
      );
      expect(statuses.every((r) => r.status === 200)).toBe(true);
    });
  });

  describe("GET /public/stats", () => {
    it("counts active players and finished matches only", async () => {
      const res = await http(app).get(`${API}/public/stats`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        totalPlayers: 5,
        totalMatches: 2,
        matchesToday: 1,
      });
    });
  });

  describe("GET /public/app-links", () => {
    it("returns nulls for unset config", async () => {
      const res = await http(app).get(`${API}/public/app-links`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        ios: null,
        android: null,
        version: null,
        minVersion: null,
      });
    });
  });

  describe("GET /public/leaderboard", () => {
    it("orders by elo (ties by creation), skips players without games and deleted ones", async () => {
      const res = await http(app).get(`${API}/public/leaderboard`);
      expect(res.status).toBe(200);
      const rows = res.body.data as Array<Record<string, unknown>>;
      expect(rows.map((r) => r.username)).toEqual([
        "TopDog",
        "MidCat",
        "TieFish",
        "LowBird",
      ]);
      expect(rows.map((r) => r.position)).toEqual([1, 2, 3, 4]);
      expect(rows.map((r) => r.elo)).toEqual([1800, 1400, 1400, 900]);
      // wins are summed across modes.
      expect(rows[0].wins).toBe(10);
      expect(rows[0].avatarUrl).toBe("https://res.cloudinary.com/demo/top.png");
    });

    it("exposes only whitelisted fields (no id, email, hash)", async () => {
      const res = await http(app).get(`${API}/public/leaderboard`);
      for (const row of res.body.data) {
        expect(Object.keys(row).sort()).toEqual([
          "avatarUrl",
          "elo",
          "position",
          "rank",
          "username",
          "wins",
        ]);
      }
      expect(containsText(res.body, "email")).toBe(false);
      expect(containsText(res.body, "example.com")).toBe(false);
      expect(containsText(res.body, "passwordHash")).toBe(false);
    });

    it("paginates with limit/offset keeping absolute positions", async () => {
      const res = await http(app).get(
        `${API}/public/leaderboard?limit=2&offset=1`,
      );
      expect(res.status).toBe(200);
      expect(
        res.body.data.map((r: { username: string; position: number }) => [
          r.username,
          r.position,
        ]),
      ).toEqual([
        ["MidCat", 2],
        ["TieFish", 3],
      ]);
    });

    it.each([
      ["limit=500"],
      ["limit=101"],
      ["limit=0"],
      ["limit=-1"],
      ["limit=abc"],
      ["offset=-1"],
      ["limit=1.5"],
      ["foo=bar"],
    ])("rejects %s with 400", async (query) => {
      const res = await http(app).get(`${API}/public/leaderboard?${query}`);
      expect(res.status).toBe(400);
    });

    it("accepts limit=100", async () => {
      expect(
        (await http(app).get(`${API}/public/leaderboard?limit=100`)).status,
      ).toBe(200);
    });
  });

  describe("GET /public/players/:username", () => {
    it("returns the aggregated public profile, case-insensitively, without email", async () => {
      const res = await http(app).get(`${API}/public/players/topdog`);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        username: "TopDog",
        elo: 1800,
        rank: "PLATA",
        stats: { games: 12, wins: 10, losses: 2, draws: 0 },
      });
      expect(Object.keys(res.body.data).sort()).toEqual([
        "avatarUrl",
        "createdAt",
        "elo",
        "rank",
        "stats",
        "username",
      ]);
      expect(containsText(res.body, "email")).toBe(false);
      expect(containsText(res.body, "example.com")).toBe(false);
    });

    it("returns 404 for unknown and soft-deleted players", async () => {
      expect(
        (await http(app).get(`${API}/public/players/nobodyhere`)).status,
      ).toBe(404);
      expect(
        (await http(app).get(`${API}/public/players/GoneUser`)).status,
      ).toBe(404);
    });

    it.each([
      ["has%20space"],
      ["semi;colon"],
      ["a".repeat(25)],
      ["quote%27"],
      ["%3Cscript%3E"],
    ])("rejects malformed username %s with 400", async (name) => {
      const res = await http(app).get(`${API}/public/players/${name}`);
      expect(res.status).toBe(400);
    });
  });

  describe("POST /public/waitlist", () => {
    it("is idempotent and normalizes the email (trim + lowercase)", async () => {
      const ip = "198.51.100.20";
      const post = (email: string, extra: Record<string, unknown> = {}) =>
        http(app)
          .post(`${API}/public/waitlist`)
          .set("X-Forwarded-For", ip)
          .send({ email, captchaToken: "ok-token", ...extra });

      const first = await post("  Fan@Example.COM ", {
        locale: "pt",
        source: " landing ",
      });
      const second = await post("fan@example.com", { locale: "en" });
      const third = await post("FAN@EXAMPLE.COM");

      for (const r of [first, second, third]) {
        expect(r.status).toBe(200);
        expect(r.body.data).toEqual({ subscribed: true });
      }
      const rows = await db.waitlistSubscriber.findMany({
        where: { email: "fan@example.com" },
      });
      expect(rows).toHaveLength(1);
      // First write wins; later calls do not overwrite.
      expect(rows[0]).toMatchObject({ locale: "PT", source: "landing" });
    });

    it("does not reveal whether an unsubscribed email already exists", async () => {
      await db.waitlistSubscriber.create({
        data: { email: "gone@example.com", unsubscribedAt: new Date() },
      });
      const res = await http(app)
        .post(`${API}/public/waitlist`)
        .set("X-Forwarded-For", "198.51.100.21")
        .send({ email: "gone@example.com", captchaToken: "ok-token" });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ subscribed: true });
      const row = await db.waitlistSubscriber.findUniqueOrThrow({
        where: { email: "gone@example.com" },
      });
      expect(row.unsubscribedAt).not.toBeNull();
    });

    it.each([
      ["invalid email", { email: "nope" }],
      ["missing email", {}],
      ["unknown locale", { email: "a@example.com", locale: "fr" }],
      ["source too long", { email: "a@example.com", source: "x".repeat(65) }],
      ["extra field", { email: "a@example.com", admin: true }],
      ["missing captchaToken", { email: "a@example.com", captchaToken: undefined }],
      [
        "captchaToken too long",
        { email: "a@example.com", captchaToken: "t".repeat(2049) },
      ],
    ])("rejects %s with 400", async (_name, body) => {
      const res = await http(app)
        .post(`${API}/public/waitlist`)
        .set("X-Forwarded-For", freshIp())
        .send({ captchaToken: "ok-token", ...body });
      expect(res.status).toBe(400);
    });
  });

  describe("POST /public/contact", () => {

    it("stores a cleaned message with a salted IP hash instead of the IP", async () => {
      const ip = "198.51.100.30";
      const res = await http(app)
        .post(`${API}/public/contact`)
        .set("X-Forwarded-For", ip)
        .send(payload);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ received: true });

      const row = await db.contactMessage.findFirstOrThrow({
        where: { email: "ada@example.com" },
      });
      expect(row).toMatchObject({
        name: "Ada Lovelace",
        subject: "Hello there",
        message: "Line one\n\nLine two",
      });
      expect(row.ipHash).toBe(
        createHash("sha256").update(`${ip}e2e-contact-salt`).digest("hex"),
      );
      expect(JSON.stringify(row)).not.toContain(ip);
    });

    it.each([
      ["empty name", { name: "   " }],
      ["bad email", { email: "nope" }],
      ["empty subject", { subject: "" }],
      ["empty message", { message: "  " }],
      ["message too long", { message: "x".repeat(5001) }],
      ["extra field", { phone: "123" }],
      ["missing captchaToken", { captchaToken: undefined }],
    ])("rejects %s with 400", async (_name, patch) => {
      const res = await http(app)
        .post(`${API}/public/contact`)
        .set("X-Forwarded-For", freshIp())
        .send({ ...payload, ...patch });
      expect(res.status).toBe(400);
    });
  });

  describe("captcha and BFF client IP", () => {
    it("waitlist: bad-token => 403 and nothing stored", async () => {
      const res = await http(app)
        .post(`${API}/public/waitlist`)
        .set("X-Forwarded-For", freshIp())
        .send({ email: "captcha-bad@example.com", captchaToken: "bad-token" });
      expect(res.status).toBe(403);
      expect(res.body.message).toBe("Captcha verification failed");
      expect(
        await db.waitlistSubscriber.count({
          where: { email: "captcha-bad@example.com" },
        }),
      ).toBe(0);
    });

    it("contact: bad-token => 403 and nothing stored", async () => {
      const res = await http(app)
        .post(`${API}/public/contact`)
        .set("X-Forwarded-For", freshIp())
        .send({ ...payload, email: "captcha-bad@example.com", captchaToken: "bad-token" });
      expect(res.status).toBe(403);
      expect(
        await db.contactMessage.count({ where: { email: "captcha-bad@example.com" } }),
      ).toBe(0);
    });

    it("contact: ipHash uses X-Client-IP only with a valid X-BFF-Key", async () => {
      const hash = (ip: string) =>
        createHash("sha256").update(`${ip}e2e-contact-salt`).digest("hex");

      await http(app)
        .post(`${API}/public/contact`)
        .set("X-Forwarded-For", "198.51.100.40")
        .set("X-BFF-Key", BFF_KEY)
        .set("X-Client-IP", "203.0.113.99")
        .send({ ...payload, subject: "via-bff" })
        .expect(200);
      await http(app)
        .post(`${API}/public/contact`)
        .set("X-Forwarded-For", "198.51.100.41")
        .set("X-Client-IP", "203.0.113.99")
        .send({ ...payload, subject: "no-key" })
        .expect(200);

      const viaBff = await db.contactMessage.findFirstOrThrow({
        where: { subject: "via-bff" },
      });
      const noKey = await db.contactMessage.findFirstOrThrow({
        where: { subject: "no-key" },
      });
      expect(viaBff.ipHash).toBe(hash("203.0.113.99"));
      expect(noKey.ipHash).toBe(hash("198.51.100.41"));
    });
  });

  describe("rate limiting", () => {
    let limited: INestApplication;
    beforeAll(async () => {
      limited = await createApp();
    });
    afterAll(async () => {
      await limited.close();
    });

    it("waitlist: 5/min per client, 429 on the sixth", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await http(limited)
          .post(`${API}/public/waitlist`)
          .set("X-Forwarded-For", "192.0.2.50")
          .send({ email: `rl${i}@example.com`, captchaToken: "ok-token" });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);

      const other = await http(limited)
        .post(`${API}/public/waitlist`)
        .set("X-Forwarded-For", "192.0.2.51")
        .send({ email: "rl-other@example.com", captchaToken: "ok-token" });
      expect(other.status).toBe(200);
    });

    it("contact: 3/min per client, 429 on the fourth", async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++) {
        const res = await http(limited)
          .post(`${API}/public/contact`)
          .set("X-Forwarded-For", "192.0.2.60")
          .send({
            name: "n",
            email: "c@example.com",
            subject: "s",
            message: `m${i}`,
            captchaToken: "ok-token",
          });
        statuses.push(res.status);
      }
      expect(statuses).toEqual([200, 200, 200, 429]);
    });
  });
});

import { INestApplication } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaService } from "../src/prisma/prisma.service";
import { createApp } from "./utils/app";
import {
  API,
  PASSWORD,
  bearer,
  createDb,
  freshIp,
  http,
  registerUser,
  truncateAll,
} from "./utils/helpers";

const LEAK_MARKERS = [
  "node_modules",
  "/src/",
  "at Object.",
  "PrismaClient",
  "prisma.",
  "invocation",
  "players",
];

function expectNoInternals(text: string): void {
  for (const marker of LEAK_MARKERS) {
    expect(text).not.toContain(marker);
  }
}

describe("Error handling (e2e)", () => {
  let app: INestApplication;
  let db: PrismaClient;

  beforeAll(async () => {
    db = createDb();
    await truncateAll(db);
    app = await createApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app.close();
    await db.$disconnect();
  });

  describe("client errors", () => {
    it("returns a clean 404 for unknown routes (no stack, no internals)", async () => {
      const res = await http(app).get(`${API}/does/not/exist`);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        statusCode: 404,
        message: expect.any(String),
        timestamp: expect.any(String),
      });
      expect(res.body.stack).toBeUndefined();
      expectNoInternals(res.text);
    });

    it("does not serve routes outside the api/v1 prefix", async () => {
      expect((await http(app).get("/health")).status).toBe(404);
      expect((await http(app).get("/player/me")).status).toBe(404);
    });

    it("returns 404/405-style clean errors for wrong methods", async () => {
      const res = await http(app).delete(`${API}/health`);
      expect(res.status).toBe(404);
      expect(res.body.stack).toBeUndefined();
    });

    it("returns 400 for malformed JSON", async () => {
      const res = await http(app)
        .post(`${API}/auth/login`)
        .set("X-Forwarded-For", freshIp())
        .set("Content-Type", "application/json")
        .send('{"username": "abc",');
      expect(res.status).toBe(400);
      expect(res.body.stack).toBeUndefined();
      expectNoInternals(res.text);
    });

    it(
      "returns 413 for bodies above the 100kb JSON limit",
      async () => {
        const res = await http(app)
          .post(`${API}/auth/login`)
          .set("X-Forwarded-For", freshIp())
          .send({ username: "abc", password: "x".repeat(150_000) });
        expect(res.status).toBe(413);
        expect(res.body.stack).toBeUndefined();
      },
    );

    it("returns 400 (not 500) for malformed JSON", async () => {
      const res = await http(app)
        .post(`${API}/auth/login`)
        .set("X-Forwarded-For", freshIp())
        .set("Content-Type", "application/json")
        .send('{"username": abc');
      expect(res.status).toBe(400);
      expect(res.body.stack).toBeUndefined();
    });

    it("returns a structured 400 with validation messages", async () => {
      const res = await http(app)
        .post(`${API}/auth/register`)
        .set("X-Forwarded-For", freshIp())
        .send({ username: "!", email: "x", password: "1" });
      expect(res.status).toBe(400);
      expect(res.body.statusCode).toBe(400);
      expect(res.body.message).toBeDefined();
      expect(res.body.timestamp).toEqual(expect.any(String));
      expect(res.body.stack).toBeUndefined();
    });

    it("401 bodies are generic and stack-free", async () => {
      const res = await http(app).get(`${API}/player/me`).set(bearer("x.y.z"));
      expect(res.status).toBe(401);
      expect(res.body.stack).toBeUndefined();
      expectNoInternals(res.text);
    });
  });

  describe("forced internal failures", () => {
    const prismaError = () =>
      new Prisma.PrismaClientKnownRequestError(
        "Invalid `prisma.player.findMany()` invocation: The column `players.secret_col` does not exist in the current database.",
        {
          code: "P2022",
          clientVersion: "e2e",
          meta: { table: "players", column: "secret_col" },
        },
      );

    it("does not leak Prisma messages on a 500 from a public endpoint", async () => {
      const prisma = app.get(PrismaService);
      jest
        .spyOn(prisma.player, "findMany")
        .mockRejectedValueOnce(prismaError());

      const res = await http(app).get(`${API}/public/leaderboard?limit=7`);
      expect(res.status).toBe(500);
      expect(res.body.message).toBe("Internal server error");
      expect(res.body.stack).toBeUndefined();
      expect(res.body.errors).toBeUndefined();
      expectNoInternals(res.text);
      expect(res.text).not.toContain("secret_col");
      expect(res.text).not.toContain("P2022");
    });

    it("does not leak Prisma messages on a 500 from an authenticated flow", async () => {
      const user = await registerUser(app);
      const prisma = app.get(PrismaService);
      jest
        .spyOn(prisma.playerStats, "findMany")
        .mockRejectedValueOnce(prismaError());

      const res = await http(app)
        .get(`${API}/player/me/stats`)
        .set(bearer(user.accessToken));
      expect(res.status).toBe(500);
      expect(res.body.message).toBe("Internal server error");
      expectNoInternals(res.text);
      expect(res.text).not.toContain("secret_col");
    });

    it("does not leak internals when login hits an unexpected failure", async () => {
      const user = await registerUser(app);
      const prisma = app.get(PrismaService);
      jest
        .spyOn(prisma.player, "findFirst")
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED 10.0.0.5:5432"));

      const res = await http(app)
        .post(`${API}/auth/login`)
        .set("X-Forwarded-For", freshIp())
        .send({ username: user.username, password: PASSWORD });
      expect(res.status).toBe(500);
      expect(res.body.message).toBe("Internal server error");
      expect(res.text).not.toContain("ECONNREFUSED");
      expect(res.text).not.toContain("10.0.0.5");
    });

    it("/health answers 503 with a generic message when the DB check fails", async () => {
      const prisma = app.get(PrismaService);
      jest
        .spyOn(prisma, "$queryRaw")
        .mockRejectedValueOnce(
          new Error('password authentication failed for user "postgres"'),
        );

      const res = await http(app).get(`${API}/health`);
      expect(res.status).toBe(503);
      expect(res.body.message).toBe("Service unavailable");
      expect(res.text).not.toContain("password authentication");
    });

    it("recovers after a failure (next request succeeds)", async () => {
      const res = await http(app).get(`${API}/health`);
      expect(res.status).toBe(200);
    });
  });

  describe("transport hardening", () => {
    it("sends helmet headers and hides x-powered-by", async () => {
      const res = await http(app).get(`${API}/health`);
      expect(res.headers["x-powered-by"]).toBeUndefined();
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("answers CORS preflight only for the configured origin", async () => {
      const allowed = await http(app)
        .options(`${API}/auth/login`)
        .set("Origin", "http://localhost:8081")
        .set("Access-Control-Request-Method", "POST");
      expect(allowed.headers["access-control-allow-origin"]).toBe(
        "http://localhost:8081",
      );
      expect(allowed.headers["access-control-allow-credentials"]).toBe("true");

      const denied = await http(app)
        .options(`${API}/auth/login`)
        .set("Origin", "https://evil.example.com")
        .set("Access-Control-Request-Method", "POST");
      expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("trust proxy: throttling keys on X-Forwarded-For (distinct IPs do not share a bucket)", async () => {
      const a = await http(app)
        .get(`${API}/public/app-links`)
        .set("X-Forwarded-For", freshIp());
      const b = await http(app)
        .get(`${API}/public/app-links`)
        .set("X-Forwarded-For", freshIp());
      expect(a.status).toBe(200);
      expect(a.headers["x-ratelimit-remaining"]).toBe(
        b.headers["x-ratelimit-remaining"],
      );

      const ip = freshIp();
      const first = await http(app)
        .get(`${API}/public/app-links`)
        .set("X-Forwarded-For", ip);
      const second = await http(app)
        .get(`${API}/public/app-links`)
        .set("X-Forwarded-For", ip);
      expect(Number(second.headers["x-ratelimit-remaining"])).toBe(
        Number(first.headers["x-ratelimit-remaining"]) - 1,
      );
    });
  });
});

import { INestApplication } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import { createApp } from "./utils/app";
import {
  API,
  ITestUser,
  bearer,
  createDb,
  http,
  registerUser,
  truncateAll,
} from "./utils/helpers";
import { assertNoSecretLeak, submitMove } from "./utils/play";
import { Solver } from "./utils/solver";

const REDIS_UP = process.env.E2E_REDIS_UP === "1";
const join = (
  app: INestApplication,
  user: ITestUser,
  body: Record<string, unknown> = { maxTurns: 20 },
) =>
  http(app)
    .post(`${API}/room/global/join`)
    .set(bearer(user.accessToken))
    .send(body);

(REDIS_UP ? describe : describe.skip)(
  "Global matchmaking with Redis (e2e)",
  () => {
    let app: INestApplication;
    let db: PrismaClient;
    let redis: Redis;

    beforeAll(async () => {
      db = createDb();
      await truncateAll(db);
      redis = new Redis({ host: "127.0.0.1", port: 63990 });
      await redis.flushdb(); // disposable test Redis only
      app = await createApp();
    });

    beforeEach(async () => {
      await redis.flushdb();
    });

    afterAll(async () => {
      await app.close();
      await redis.quit();
      await db.$disconnect();
    });

    it("queues the first player and matches the second one", async () => {
      const a = await registerUser(app);
      const b = await registerUser(app);

      const first = await join(app, a);
      expect(first.status).toBe(201);
      expect(first.body.data).toMatchObject({
        status: "queued",
        queuePosition: 1,
      });

      // Joining twice keeps a single place in the queue.
      const again = await join(app, a);
      expect(again.body.data).toMatchObject({
        status: "queued",
        queuePosition: 1,
      });

      const second = await join(app, b);
      expect(second.status).toBe(201);
      expect(second.body.data.status).toBe("matched");
      const match = second.body.data.match;
      expect(match).toMatchObject({
        mode: "GLOBAL",
        status: "PLAYING",
        maxTurns: 20,
      });
      expect([match.player1Id, match.player2Id].sort()).toEqual(
        [a.id, b.id].sort(),
      );

      for (const user of [a, b]) {
        const view = await http(app)
          .get(`${API}/match/${match.id}`)
          .set(bearer(user.accessToken));
        expect(view.status).toBe(200);
        expect(view.body.data.isRanked).toBe(true);
      }
      assertNoSecretLeak(second.body, "0000");
      expect(JSON.stringify(second.body)).not.toContain("secretNumber");

      // Both left the queue.
      expect(await redis.zcard("mm:global:queue")).toBe(0);
    });

    it("does not match a player with themselves and supports leaving the queue", async () => {
      const a = await registerUser(app);
      await join(app, a);
      const solo = await join(app, a);
      expect(solo.body.data.status).toBe("queued");

      const left = await http(app)
        .delete(`${API}/room/global/leave`)
        .set(bearer(a.accessToken));
      expect(left.status).toBe(200);
      expect(await redis.zcard("mm:global:queue")).toBe(0);

      const b = await registerUser(app);
      const alone = await join(app, b);
      expect(alone.body.data.status).toBe("queued");
    });

    it("rejects invalid maxTurns", async () => {
      const a = await registerUser(app);
      expect((await join(app, a, { maxTurns: 99 })).status).toBe(400);
      expect((await join(app, a, { foo: 1 })).status).toBe(400);
    });

    it("plays a ranked match to the end and moves ELO symmetrically", async () => {
      const a = await registerUser(app);
      const b = await registerUser(app);
      await join(app, a);
      const matched = await join(app, b);
      const match = matched.body.data.match;
      const matchId: string = match.id;

      const players: Record<number, ITestUser> = {
        1: a.id === match.player1Id ? a : b,
        2: a.id === match.player1Id ? b : a,
      };
      const solvers = { 1: new Solver(), 2: new Solver() };
      let seat = match.currentSeat as 1 | 2;
      let winnerId: string | null = null;

      for (let i = 0; i < 60 && winnerId === null; i++) {
        const guess = solvers[seat].next();
        const res = await submitMove(app, players[seat], matchId, guess);
        expect(res.status).toBe(201);
        solvers[seat].observe(guess, res.body.data.move);
        if (res.body.data.matchStatus === "FINISHED")
          winnerId = res.body.data.winnerId ?? "draw";
        seat = seat === 1 ? 2 : 1;
      }
      expect(winnerId).not.toBeNull();
      expect(winnerId).not.toBe("draw");

      const loser = winnerId === a.id ? b : a;
      const winner = winnerId === a.id ? a : b;
      const [wHist, lHist] = await Promise.all(
        [winner, loser].map((u) =>
          http(app)
            .get(`${API}/player/me/elo-history`)
            .set(bearer(u.accessToken)),
        ),
      );
      expect(wHist.body.data).toHaveLength(1);
      expect(lHist.body.data).toHaveLength(1);
      expect(wHist.body.data[0]).toMatchObject({
        matchId,
        mode: "GLOBAL",
        result: "WIN",
        eloBefore: 1000,
      });
      expect(wHist.body.data[0].delta).toBeGreaterThan(0);
      expect(lHist.body.data[0].delta).toBeLessThan(0);
      expect(wHist.body.data[0].delta + lHist.body.data[0].delta).toBe(0);

      const me = await http(app)
        .get(`${API}/player/me`)
        .set(bearer(winner.accessToken));
      expect(me.body.data.elo).toBe(wHist.body.data[0].eloAfter);

      const board = await http(app).get(`${API}/public/leaderboard`);
      expect(board.body.data[0].username).toBe(winner.username);
    });
  },
);

import { randomUUID } from "crypto";
import { INestApplication } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
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

interface IOfflineMatch {
  clientMatchId: string;
  aiDifficulty: string;
  result: string;
  attemptsUsed: number;
  maxTurns?: number;
  totalPicos: number;
  totalPalas: number;
  durationSec: number;
  finishedAt?: string;
}

const win = (overrides: Partial<IOfflineMatch> = {}): IOfflineMatch => ({
  clientMatchId: randomUUID(),
  aiDifficulty: "EASY",
  result: "WIN",
  attemptsUsed: 6,
  totalPicos: 7,
  totalPalas: 8,
  durationSec: 90,
  ...overrides,
});

describe("POST /stats/sync (e2e)", () => {
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

  const sync = (user: ITestUser, matches: unknown) =>
    http(app)
      .post(`${API}/stats/sync`)
      .set(bearer(user.accessToken))
      .send({ matches });

  const statsRow = (playerId: string) =>
    db.playerStats.findUnique({
      where: { playerId_mode: { playerId, mode: "VERSUS_AI" } },
    });

  it("requires authentication", async () => {
    const res = await http(app)
      .post(`${API}/stats/sync`)
      .send({ matches: [win()] });
    expect(res.status).toBe(401);
  });

  it("records offline matches and updates PlayerStats", async () => {
    const user = await registerUser(app);
    const a = win({ attemptsUsed: 6, totalPicos: 7, totalPalas: 8 });
    const b = win({ attemptsUsed: 4, totalPicos: 6, totalPalas: 3 });
    const c = win({
      result: "LOSS",
      attemptsUsed: 5,
      totalPicos: 3,
      totalPalas: 6,
    });

    const res = await sync(user, [a, b, c]);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ synced: 3, duplicates: 0 });
    expect(
      res.body.data.results.map((r: { status: string }) => r.status),
    ).toEqual(["created", "created", "created"]);

    const row = await statsRow(user.id);
    expect(row).toMatchObject({
      games: 3,
      wins: 2,
      losses: 1,
      draws: 0,
      // Order matters: win, win, loss -> streak resets.
      currentStreak: 0,
      bestStreak: 2,
      bestAttempts: 4,
      totalAttempts: 15,
      totalPicos: 16,
      totalPalas: 17,
      totalDurationSec: 270,
    });

    const history = await http(app)
      .get(`${API}/player/me/matches`)
      .set(bearer(user.accessToken));
    expect(history.body.data.total).toBe(3);
    const synced = await db.match.findUniqueOrThrow({
      where: { clientMatchId: a.clientMatchId },
    });
    expect(synced).toMatchObject({
      source: "OFFLINE_SYNC",
      status: "FINISHED",
      isRanked: false,
      mode: "VERSUS_AI",
    });

    const player = await http(app)
      .get(`${API}/player/me`)
      .set(bearer(user.accessToken));
    expect(player.body.data.elo).toBe(1000);
  });

  it("is idempotent per clientMatchId (second time reports duplicate, stats unchanged)", async () => {
    const user = await registerUser(app);
    const m = win();

    const first = await sync(user, [m]);
    expect(first.body.data.results[0].status).toBe("created");
    const second = await sync(user, [m]);
    expect(second.status).toBe(201);
    expect(second.body.data).toMatchObject({ synced: 0, duplicates: 1 });
    expect(second.body.data.results[0]).toMatchObject({
      clientMatchId: m.clientMatchId,
      status: "duplicate",
      matchId: first.body.data.results[0].matchId,
    });

    expect((await statsRow(user.id))?.games).toBe(1);
    expect(
      await db.match.count({ where: { clientMatchId: m.clientMatchId } }),
    ).toBe(1);

    // Mixed batch: one known, one new.
    const fresh = win();
    const mixed = await sync(user, [m, fresh]);
    expect(mixed.body.data).toMatchObject({ synced: 1, duplicates: 1 });
    expect((await statsRow(user.id))?.games).toBe(2);
  });

  it("is safe under concurrent retries of the same batch", async () => {
    const user = await registerUser(app);
    const m = win();
    const results = await Promise.all([
      sync(user, [m]),
      sync(user, [m]),
      sync(user, [m]),
    ]);
    results.forEach((r) => expect(r.status).toBe(201));
    const created = results.reduce((s, r) => s + r.body.data.synced, 0);
    expect(created).toBe(1);
    expect((await statsRow(user.id))?.games).toBe(1);
  });

  it("rejects a clientMatchId owned by another player with 409 and leaves stats intact", async () => {
    const owner = await registerUser(app);
    const thief = await registerUser(app);
    const m = win();
    expect((await sync(owner, [m])).status).toBe(201);

    const res = await sync(thief, [m]);
    expect(res.status).toBe(409);
    expect(await statsRow(thief.id)).toBeNull();
    expect((await statsRow(owner.id))?.games).toBe(1);
  });

  describe("DTO validation", () => {
    it("accepts exactly 50 matches and rejects 51", async () => {
      const user = await registerUser(app);
      const fifty = Array.from({ length: 50 }, () =>
        win({ attemptsUsed: 4, totalPicos: 4, totalPalas: 0 }),
      );
      const ok = await sync(user, fifty);
      expect(ok.status).toBe(201);
      expect(ok.body.data.synced).toBe(50);

      const tooMany = await sync(user, [...fifty, win()]);
      expect(tooMany.status).toBe(400);
      expect((await statsRow(user.id))?.games).toBe(50);
    }, 60000);

    it.each([
      ["empty array", []],
      ["not an array", "nope"],
      ["missing matches", undefined],
    ])("rejects %s", async (_name, matches) => {
      const user = await registerUser(app);
      const res = await sync(user, matches);
      expect(res.status).toBe(400);
    });

    it.each([
      ["non-uuid clientMatchId", { clientMatchId: "abc" }],
      ["uuid v1", { clientMatchId: "c232ab00-9414-11ec-b3c8-9f6bdeced846" }],
      ["unknown difficulty", { aiDifficulty: "GODLIKE" }],
      ["unknown result", { result: "WON" }],
      ["attemptsUsed 0", { attemptsUsed: 0 }],
      ["attemptsUsed 21", { attemptsUsed: 21 }],
      ["fractional attempts", { attemptsUsed: 2.5 }],
      ["maxTurns 21", { maxTurns: 21 }],
      ["negative picos", { totalPicos: -1 }],
      ["picos above 80", { totalPicos: 81 }],
      ["palas above 80", { totalPalas: 81 }],
      ["negative duration", { durationSec: -1 }],
      ["duration above one day", { durationSec: 86401 }],
      ["bad finishedAt", { finishedAt: "yesterday" }],
      ["extra field (elo)", { elo: 3000 }],
    ])("rejects %s with 400 and persists nothing", async (_name, patch) => {
      const user = await registerUser(app);
      const res = await sync(user, [win(patch as Partial<IOfflineMatch>)]);
      expect(res.status).toBe(400);
      expect(await statsRow(user.id)).toBeNull();
    });

    it("rejects a duplicated clientMatchId inside one request", async () => {
      const user = await registerUser(app);
      const m = win();
      const res = await sync(user, [m, { ...m }]);
      expect(res.status).toBe(400);
      expect(await statsRow(user.id)).toBeNull();
    });
  });

  describe("plausibility", () => {
    it.each([
      [
        "attemptsUsed above maxTurns",
        { attemptsUsed: 9, maxTurns: 8, totalPicos: 4, totalPalas: 0 },
      ],
      [
        "attemptsUsed above default maxTurns (12)",
        { attemptsUsed: 13, totalPicos: 4, totalPalas: 0 },
      ],
      [
        "more feedback than 4 per attempt",
        { attemptsUsed: 2, totalPicos: 5, totalPalas: 4 },
      ],
      [
        "win without 4 picos",
        { result: "WIN", attemptsUsed: 5, totalPicos: 3, totalPalas: 2 },
      ],
      [
        "finishedAt in the future",
        { finishedAt: new Date(Date.now() + 3600_000).toISOString() },
      ],
    ])(
      "rejects %s with 400 and does not partially apply the batch",
      async (_name, patch) => {
        const user = await registerUser(app);
        const good = win();
        const res = await sync(user, [
          good,
          win(patch as Partial<IOfflineMatch>),
        ]);
        expect(res.status).toBe(400);
        expect(await statsRow(user.id)).toBeNull();
        expect(
          await db.match.count({
            where: { clientMatchId: good.clientMatchId },
          }),
        ).toBe(0);
      },
    );

    it("accepts boundary values (attemptsUsed == maxTurns, feedback == 4 per attempt)", async () => {
      const user = await registerUser(app);
      const res = await sync(user, [
        win({ attemptsUsed: 8, maxTurns: 8, totalPicos: 20, totalPalas: 12 }),
        win({
          result: "DRAW",
          attemptsUsed: 3,
          totalPicos: 0,
          totalPalas: 12,
          finishedAt: new Date().toISOString(),
        }),
      ]);
      expect(res.status).toBe(201);
      const row = await statsRow(user.id);
      expect(row).toMatchObject({ games: 2, wins: 1, draws: 1 });
    });
  });
});

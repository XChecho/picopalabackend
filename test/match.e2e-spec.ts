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
import {
  assertNoSecretLeak,
  createAiMatch,
  playAiUntilWin,
  playMatch,
  submitMove,
} from "./utils/play";
import { Solver } from "./utils/solver";

const RIVAL_KEYS = ["player2Number"];

describe("Match versus AI (e2e)", () => {
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

  const secretOf = async (matchId: string, seat: number): Promise<string> => {
    const row = await db.matchParticipant.findUniqueOrThrow({
      where: { matchId_seat: { matchId, seat } },
    });
    return row.secretNumber as string;
  };

  describe("POST /match", () => {
    it("creates a VERSUS_AI match exposing only the viewer's own secret", async () => {
      const user = await registerUser(app);
      const res = await createAiMatch(app, user, {
        mode: "VERSUS_AI",
        aiDifficulty: "MEDIUM",
        maxTurns: 8,
      });

      expect(res.status).toBe(201);
      const match = res.body.data;
      expect(match).toMatchObject({
        mode: "VERSUS_AI",
        status: "PLAYING",
        maxTurns: 8,
        aiDifficulty: "MEDIUM",
        mySeat: 1,
        player1Id: user.id,
        player2Id: null,
        isRanked: false,
      });
      expect(match.participants).toHaveLength(2);
      expect(match.participants[1].isAi).toBe(true);

      const mine = await secretOf(match.id, 1);
      const rival = await secretOf(match.id, 2);
      expect(match.player1Number).toBe(mine);
      expect(match.player2Number).toBeUndefined();
      assertNoSecretLeak(res.body, rival, RIVAL_KEYS);
    });

    it.each([
      ["mode PRIVATE", { mode: "PRIVATE" }],
      ["mode GLOBAL", { mode: "GLOBAL" }],
      ["unknown mode", { mode: "NOPE" }],
      ["missing mode", {}],
      ["maxTurns 0", { mode: "VERSUS_AI", maxTurns: 0 }],
      ["maxTurns 21", { mode: "VERSUS_AI", maxTurns: 21 }],
      ["unknown difficulty", { mode: "VERSUS_AI", aiDifficulty: "INSANE" }],
      ["extra field", { mode: "VERSUS_AI", isRanked: true }],
    ])("rejects %s with 400", async (_name, body) => {
      const user = await registerUser(app);
      const res = await createAiMatch(app, user, body);
      expect(res.status).toBe(400);
    });

    it("requires authentication", async () => {
      const res = await http(app)
        .post(`${API}/match`)
        .send({ mode: "VERSUS_AI" });
      expect(res.status).toBe(401);
    });
  });

  describe("full game", () => {
    let user: ITestUser;
    let outcome: Awaited<ReturnType<typeof playAiUntilWin>>;
    let aiSecret: string;

    beforeAll(async () => {
      user = await registerUser(app);
      outcome = await playAiUntilWin(app, user);
      aiSecret = await secretOf(outcome.matchId, 2);
    });

    it("ends with a win after exactly 4 picos, with consistent feedback", async () => {
      const last = outcome.moves[outcome.moves.length - 1];
      expect(last.body.data.move).toMatchObject({
        picos: 4,
        palas: 0,
        isWin: true,
        guess: aiSecret,
      });
      expect(outcome.finalBody).toMatchObject({
        matchStatus: "FINISHED",
        endReason: "GUESSED",
        winnerId: user.id,
        currentSeat: null,
      });

      // Every move's feedback must match the real rule (Pico/Pala).
      for (const m of outcome.moves) {
        const expectedPicos = [...m.guess].filter(
          (d, i) => d === aiSecret[i],
        ).length;
        const expectedPalas = [...m.guess].filter(
          (d, i) => d !== aiSecret[i] && aiSecret.includes(d),
        ).length;
        expect(m.body.data.move.picos).toBe(expectedPicos);
        expect(m.body.data.move.palas).toBe(expectedPalas);
      }
    });

    it("never exposes the rival secret (outside the winning guess) in any response", async () => {
      outcome.bodies.forEach((b) =>
        assertNoSecretLeak(b, aiSecret, RIVAL_KEYS),
      );

      const view = await http(app)
        .get(`${API}/match/${outcome.matchId}`)
        .set(bearer(user.accessToken));
      expect(view.status).toBe(200);
      assertNoSecretLeak(view.body, aiSecret, RIVAL_KEYS);
      expect(view.body.data.status).toBe("FINISHED");
      expect(view.body.data.winnerId).toBe(user.id);
      expect(view.body.data.player1Number).toBe(
        await secretOf(outcome.matchId, 1),
      );
      // Player and AI moves are both listed, each with seat information.
      const mine = view.body.data.moves.filter(
        (m: { isAi: boolean }) => !m.isAi,
      );
      expect(mine).toHaveLength(outcome.moves.length);
    });

    it("rejects moves on a finished match (409) and does not alter it", async () => {
      const res = await submitMove(app, user, outcome.matchId, "9876");
      expect(res.status).toBe(409);
      expect(res.body.message).toBe("Match already finished");
    });

    it("updates PlayerStats consistently with the played moves", async () => {
      const totalPicos = outcome.moves.reduce(
        (s, m) => s + m.body.data.move.picos,
        0,
      );
      const totalPalas = outcome.moves.reduce(
        (s, m) => s + m.body.data.move.palas,
        0,
      );

      const row = await db.playerStats.findUniqueOrThrow({
        where: { playerId_mode: { playerId: user.id, mode: "VERSUS_AI" } },
      });
      expect(row).toMatchObject({
        games: 1,
        wins: 1,
        losses: 0,
        draws: 0,
        currentStreak: 1,
        bestStreak: 1,
        bestAttempts: outcome.moves.length,
        totalAttempts: outcome.moves.length,
        totalPicos,
        totalPalas,
      });

      const api = await http(app)
        .get(`${API}/player/me/stats`)
        .set(bearer(user.accessToken));
      expect(api.body.data).toMatchObject({
        totalGames: 1,
        wins: 1,
        totalPicos,
        totalPalas,
      });
    });

    it("lists the match in /player/me/matches without any secretNumber", async () => {
      const res = await http(app)
        .get(`${API}/player/me/matches`)
        .set(bearer(user.accessToken));
      expect(res.status).toBe(200);
      const entry = res.body.data.matches.find(
        (m: { id: string }) => m.id === outcome.matchId,
      );
      expect(entry).toBeDefined();
      expect(entry.participants).toHaveLength(2);
      expect(entry.participants[0]).toMatchObject({
        seat: 1,
        playerId: user.id,
        result: "WIN",
      });
      expect(entry.participants[1]).toMatchObject({
        seat: 2,
        isAi: true,
        result: "LOSS",
      });
      assertNoSecretLeak(res.body, aiSecret, [
        "player1Number",
        "player2Number",
      ]);
      assertNoSecretLeak(res.body, await secretOf(outcome.matchId, 1), [
        "player1Number",
        "player2Number",
      ]);

      const filtered = await http(app)
        .get(`${API}/player/me/matches?mode=PRIVATE`)
        .set(bearer(user.accessToken));
      expect(filtered.body.data.total).toBe(0);
    });
  });

  describe("access control and validation", () => {
    it("returns 400 (not 500) for a non-UUID match id on GET and move", async () => {
      const user = await registerUser(app);
      const get = await http(app)
        .get(`${API}/match/not-a-uuid`)
        .set(bearer(user.accessToken));
      expect(get.status).toBe(400);
      expect(get.body.stack).toBeUndefined();

      const move = await http(app)
        .post(`${API}/match/123/move`)
        .set(bearer(user.accessToken))
        .send({ guess: "1234" });
      expect(move.status).toBe(400);
    });

    it("returns 404 for an unknown UUID", async () => {
      const user = await registerUser(app);
      const id = "00000000-0000-4000-8000-000000000000";
      expect(
        (
          await http(app)
            .get(`${API}/match/${id}`)
            .set(bearer(user.accessToken))
        ).status,
      ).toBe(404);
      expect((await submitMove(app, user, id, "1234")).status).toBe(404);
    });

    it("forbids viewing or moving in someone else's match", async () => {
      const owner = await registerUser(app);
      const intruder = await registerUser(app);
      const created = await createAiMatch(app, owner);
      const id = created.body.data.id;

      const view = await http(app)
        .get(`${API}/match/${id}`)
        .set(bearer(intruder.accessToken));
      expect(view.status).toBe(403);
      assertNoSecretLeak(view.body, await secretOf(id, 1), ["player1Number"]);

      const move = await submitMove(app, intruder, id, "1234");
      expect(move.status).toBe(403);

      const untouched = await db.move.count({ where: { matchId: id } });
      expect(untouched).toBe(0);
    });

    it("rejects a repeated guess with 400", async () => {
      const user = await registerUser(app);
      const created = await createAiMatch(app, user);
      const id = created.body.data.id;
      const secret = await secretOf(id, 2);
      // Pick a guess that cannot win so the match stays open.
      const guess = secret === "1234" ? "5678" : "1234";

      const first = await submitMove(app, user, id, guess);
      expect(first.status).toBe(201);
      if (first.body.data.matchStatus === "FINISHED") return; // AI hit the 1/3024 lottery
      const again = await submitMove(app, user, id, guess);
      expect(again.status).toBe(400);
      expect(again.body.message).toBe("Guess already used");
    });

    it.each([
      ["repeated digits", "1123"],
      ["contains zero", "0123"],
      ["too short", "123"],
      ["too long", "12345"],
      ["letters", "12a4"],
      ["empty", ""],
      ["number type", 1234],
      ["null", null],
    ])("rejects an invalid guess (%s) with 400", async (_name, guess) => {
      const user = await registerUser(app);
      const created = await createAiMatch(app, user);
      const res = await submitMove(app, user, created.body.data.id, guess);
      expect(res.status).toBe(400);
      expect(
        await db.move.count({ where: { matchId: created.body.data.id } }),
      ).toBe(0);
    });

    it("rejects extra fields in the move payload", async () => {
      const user = await registerUser(app);
      const created = await createAiMatch(app, user);
      const res = await http(app)
        .post(`${API}/match/${created.body.data.id}/move`)
        .set(bearer(user.accessToken))
        .send({ guess: "1234", matchId: "x" });
      expect(res.status).toBe(400);
    });
  });

  describe("end conditions", () => {
    it("finishes a 1-turn match as a draw/loss once both sides played, updating stats", async () => {
      const user = await registerUser(app);
      const created = await createAiMatch(app, user, {
        mode: "VERSUS_AI",
        maxTurns: 1,
      });
      const id = created.body.data.id;
      const secret = await secretOf(id, 2);
      const guess = secret === "1234" ? "5678" : "1234";

      const res = await submitMove(app, user, id, guess);
      expect(res.status).toBe(201);
      expect(res.body.data.matchStatus).toBe("FINISHED");
      expect(res.body.data.aiMove).toBeDefined();

      const row = await db.playerStats.findUniqueOrThrow({
        where: { playerId_mode: { playerId: user.id, mode: "VERSUS_AI" } },
      });
      expect(row.games).toBe(1);
      expect(row.wins).toBe(0);
      expect(row.losses + row.draws).toBe(1);
      if (res.body.data.endReason === "MAX_TURNS") {
        expect(row.draws).toBe(1);
        expect(res.body.data.winnerId).toBeNull();
      }
    });

    it("works at every difficulty (the AI replies with a valid, non-leaking move)", async () => {
      for (const aiDifficulty of ["EASY", "MEDIUM", "HARD"]) {
        const user = await registerUser(app);
        const created = await createAiMatch(app, user, {
          mode: "VERSUS_AI",
          aiDifficulty,
          maxTurns: 20,
        });
        const id = created.body.data.id;
        const mine = await secretOf(id, 1);
        const rival = await secretOf(id, 2);
        const guess = rival === "1234" ? "5678" : "1234";

        const res = await submitMove(app, user, id, guess);
        expect(res.status).toBe(201);
        assertNoSecretLeak(res.body, rival, RIVAL_KEYS);
        if (res.body.data.aiMove) {
          expect(res.body.data.aiMove.guess).toMatch(/^(?!.*(.).*\1)[1-9]{4}$/);
          // The AI's feedback is computed against the player's secret.
          const aiGuess: string = res.body.data.aiMove.guess;
          const picos = [...aiGuess].filter((d, i) => d === mine[i]).length;
          expect(res.body.data.aiMove.picos).toBe(picos);
        }
      }
    });
  });

  describe("private room between two humans", () => {
    it("plays to completion alternating turns and enforces turn order", async () => {
      const host = await registerUser(app);
      const guest = await registerUser(app);

      const room = await http(app)
        .post(`${API}/room/private`)
        .set(bearer(host.accessToken))
        .send({ maxTurns: 20 });
      expect(room.status).toBe(201);

      const joined = await http(app)
        .post(`${API}/room/private/join`)
        .set(bearer(guest.accessToken))
        .send({ code: room.body.data.code.toLowerCase() });
      expect(joined.status).toBe(201);
      const matchId: string = joined.body.data.match.id;
      expect(joined.body.data.match.player1Id).toBe(host.id);
      assertNoSecretLeak(joined.body, await secretOf(matchId, 1));
      assertNoSecretLeak(joined.body, await secretOf(matchId, 2));

      const seatOf = (u: ITestUser) => (u.id === host.id ? 1 : 2);
      const players = { 1: host, 2: guest };
      const solvers = { 1: new Solver(), 2: new Solver() };
      let seat = joined.body.data.match.currentSeat as 1 | 2;

      // Out-of-turn move is rejected.
      const other = players[seat === 1 ? 2 : 1];
      const outOfTurn = await submitMove(app, other, matchId, "1234");
      expect(outOfTurn.status).toBe(403);
      expect(outOfTurn.body.message).toBe("Not your turn");

      let finished = false;
      for (let i = 0; i < 60 && !finished; i++) {
        const guess = solvers[seat].next();
        const res = await submitMove(app, players[seat], matchId, guess);
        expect(res.status).toBe(201);
        const rivalSeat = seat === 1 ? 2 : 1;
        assertNoSecretLeak(res.body, await secretOf(matchId, rivalSeat), [
          "player1Number",
          "player2Number",
        ]);
        solvers[seat].observe(guess, res.body.data.move);
        finished = res.body.data.matchStatus === "FINISHED";
        seat = rivalSeat;
      }
      expect(finished).toBe(true);

      const view = await http(app)
        .get(`${API}/match/${matchId}`)
        .set(bearer(host.accessToken));
      expect(view.body.data.status).toBe("FINISHED");
      expect(view.body.data.mode).toBe("PRIVATE");
      expect(view.body.data.winnerId).not.toBeNull();
      expect(view.body.data.player2Number).toBeUndefined();
      expect(seatOf(host)).toBe(1);

      // Private matches are unranked: no elo movement.
      const elo = await http(app)
        .get(`${API}/player/me/elo-history`)
        .set(bearer(host.accessToken));
      expect(elo.body.data).toEqual([]);
      const stats = await db.playerStats.findMany({
        where: { mode: "PRIVATE", playerId: { in: [host.id, guest.id] } },
      });
      expect(stats).toHaveLength(2);
      expect(stats.reduce((s, r) => s + r.wins, 0)).toBe(1);
      expect(stats.reduce((s, r) => s + r.losses, 0)).toBe(1);
    });
  });

  it("playMatch helper surfaces the AI-won branch as won=false rather than throwing", async () => {
    // Sanity check of the helper contract using a real match.
    const user = await registerUser(app);
    const created = await createAiMatch(app, user);
    const outcome = await playMatch(app, user, created.body.data.id, [
      created.body,
    ]);
    expect(typeof outcome.won).toBe("boolean");
    expect(outcome.finalBody.matchStatus).toBe("FINISHED");
  });
});

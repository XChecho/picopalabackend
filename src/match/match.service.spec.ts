import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import {
  Difficulty,
  EndReason,
  GameMode,
  MatchResult,
  MatchStatus,
  Prisma,
} from "@prisma/client";
import { EloService } from "../elo/elo.service";
import { AiService } from "../game/ai/ai.service";
import { GameService } from "../game/game.service";
import { PrismaService } from "../prisma/prisma.service";
import { StatsService } from "../stats/stats.service";
import { MatchService } from "./match.service";

const HUMAN_SECRET = "1234";
const AI_SECRET = "5678";
// Secrets that must never appear in a serialized response to the human player.
const RIVAL_SECRET = AI_SECRET;

interface ITxMock {
  match: { updateMany: jest.Mock; update: jest.Mock };
  move: { create: jest.Mock; groupBy: jest.Mock };
  matchParticipant: { update: jest.Mock; findMany: jest.Mock };
  player: { update: jest.Mock };
  room: { updateMany: jest.Mock };
  $queryRaw: jest.Mock;
}

interface IParticipantFixture {
  id: string;
  seat: number;
  playerId: string | null;
  isAi: boolean;
  secretNumber: string;
  attemptsUsed: number;
  moves: Array<{ guess: string; picos: number; palas: number }>;
}

const makeParticipants = (): IParticipantFixture[] => [
  {
    id: "part-1",
    seat: 1,
    playerId: "p1",
    isAi: false,
    secretNumber: HUMAN_SECRET,
    attemptsUsed: 0,
    moves: [],
  },
  {
    id: "part-2",
    seat: 2,
    playerId: null,
    isAi: true,
    secretNumber: AI_SECRET,
    attemptsUsed: 0,
    moves: [],
  },
];

const makeMatchRow = (overrides: Record<string, unknown> = {}) => ({
  id: "m1",
  mode: GameMode.VERSUS_AI,
  status: MatchStatus.PLAYING,
  isRanked: false,
  maxTurns: 12,
  aiDifficulty: Difficulty.EASY,
  currentSeat: 1,
  roomId: null,
  startedAt: new Date(Date.now() - 30_000),
  updatedAt: new Date("2025-01-01T00:00:00Z"),
  participants: makeParticipants(),
  ...overrides,
});

const moveRow = (
  participantId: string,
  turn: number,
  guess: string,
  picos: number,
  palas: number,
) => ({
  id: `move-${participantId}-${turn}`,
  matchId: "m1",
  participantId,
  turnNumber: turn,
  guess,
  picos,
  palas,
  isWin: picos === 4,
  createdAt: new Date("2025-01-01T00:00:01Z"),
});

describe("MatchService", () => {
  let service: MatchService;
  let prisma: {
    match: { findUnique: jest.Mock; create: jest.Mock; findFirst: jest.Mock };
    matchParticipant: { findUnique: jest.Mock; findFirst: jest.Mock };
    move: { findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: ITxMock;
  let ai: { easyMove: jest.Mock; mediumMove: jest.Mock; hardMove: jest.Mock };
  let stats: { recordResult: jest.Mock };
  let game: GameService;

  beforeEach(() => {
    tx = {
      match: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({}),
      },
      move: {
        create: jest.fn(),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      matchParticipant: {
        update: jest.fn().mockResolvedValue({}),
        findMany: jest.fn().mockResolvedValue([]),
      },
      player: { update: jest.fn().mockResolvedValue({}) },
      room: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    prisma = {
      match: {
        findUnique: jest.fn(),
        create: jest.fn(),
        findFirst: jest.fn(),
      },
      matchParticipant: {
        findUnique: jest.fn().mockResolvedValue({ secretNumber: HUMAN_SECRET }),
        findFirst: jest.fn(),
      },
      move: { findMany: jest.fn().mockResolvedValue([]) },
      $transaction: jest.fn((fn: (t: Prisma.TransactionClient) => unknown) =>
        fn(tx as unknown as Prisma.TransactionClient),
      ),
    };
    ai = {
      easyMove: jest.fn().mockReturnValue("9876"),
      mediumMove: jest.fn().mockReturnValue("9876"),
      hardMove: jest.fn().mockReturnValue("9876"),
    };
    stats = { recordResult: jest.fn().mockResolvedValue(undefined) };
    game = new GameService();

    service = new MatchService(
      prisma as unknown as PrismaService,
      game,
      ai as unknown as AiService,
      new EloService(),
      stats as unknown as StatsService,
    );

    // Default transaction behaviour: echo moves back with a stable id.
    tx.move.create.mockImplementation(
      async ({ data }: { data: Record<string, never> }) => ({
        id: `move-${data.participantId}-${data.turnNumber}`,
        matchId: data.matchId,
        participantId: data.participantId,
        turnNumber: data.turnNumber,
        guess: data.guess,
        picos: data.picos,
        palas: data.palas,
        isWin: data.isWin,
        createdAt: new Date("2025-01-01T00:00:01Z"),
      }),
    );
  });

  const expectNoSecret = (value: unknown, secret = RIVAL_SECRET): void => {
    expect(JSON.stringify(value)).not.toContain(secret);
  };

  describe("submitMove validation", () => {
    it("rejects an invalid guess before touching the database", async () => {
      await expect(service.submitMove("p1", "m1", "1123")).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.match.findUnique).not.toHaveBeenCalled();
    });

    it("throws 404 for an unknown match", async () => {
      prisma.match.findUnique.mockResolvedValue(null);
      await expect(service.submitMove("p1", "m1", "1357")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws 403 when the caller is not a participant", async () => {
      prisma.match.findUnique.mockResolvedValue(makeMatchRow());
      await expect(
        service.submitMove("intruder", "m1", "1357"),
      ).rejects.toThrow(ForbiddenException);
    });

    it.each([MatchStatus.FINISHED, MatchStatus.CANCELLED])(
      "throws 409 when the match is %s",
      async (status) => {
        prisma.match.findUnique.mockResolvedValue(makeMatchRow({ status }));
        await expect(service.submitMove("p1", "m1", "1357")).rejects.toThrow(
          ConflictException,
        );
      },
    );

    it("throws 400 when the match is not PLAYING yet", async () => {
      prisma.match.findUnique.mockResolvedValue(
        makeMatchRow({ status: MatchStatus.WAITING }),
      );
      await expect(service.submitMove("p1", "m1", "1357")).rejects.toThrow(
        "Match is not ready to play",
      );
    });

    it("throws 400 when the opponent secret is missing", async () => {
      const participants = makeParticipants();
      participants[1].secretNumber = "";
      prisma.match.findUnique.mockResolvedValue(makeMatchRow({ participants }));
      await expect(service.submitMove("p1", "m1", "1357")).rejects.toThrow(
        "Match is not ready to play",
      );
    });

    it("throws 403 when it is not the caller turn", async () => {
      prisma.match.findUnique.mockResolvedValue(
        makeMatchRow({ currentSeat: 2 }),
      );
      await expect(service.submitMove("p1", "m1", "1357")).rejects.toThrow(
        "Not your turn",
      );
    });

    it("throws 400 when the guess was already used by the caller", async () => {
      const participants = makeParticipants();
      participants[0].moves = [{ guess: "1357", picos: 0, palas: 1 }];
      participants[0].attemptsUsed = 1;
      prisma.match.findUnique.mockResolvedValue(makeMatchRow({ participants }));
      await expect(service.submitMove("p1", "m1", "1357")).rejects.toThrow(
        "Guess already used",
      );
    });
  });

  describe("submitMove versus AI", () => {
    it("stores the human move, plays the AI reply and keeps the match going", async () => {
      prisma.match.findUnique.mockResolvedValue(makeMatchRow());

      const result = await service.submitMove("p1", "m1", "5671");

      // 5671 vs AI secret 5678: picos 5,6,7 = 3 ... position-wise 5,6,7 match
      expect(result.move).toMatchObject({
        guess: "5671",
        picos: 3,
        palas: 0,
        isWin: false,
        playerId: "p1",
        seat: 1,
        turnNumber: 1,
      });
      expect(result.aiMove).toEqual({
        guess: "9876",
        // 9876 vs human secret 1234: no common digits
        picos: 0,
        palas: 0,
        isWin: false,
      });
      expect(result.matchStatus).toBe(MatchStatus.PLAYING);
      expect(result.endReason).toBeNull();
      expect(result.winnerId).toBeNull();
      expect(result.currentSeat).toBe(1);
      expect(result.nextTurn).toBe(3);
      expect(tx.match.updateMany).toHaveBeenCalledWith({
        where: {
          id: "m1",
          status: MatchStatus.PLAYING,
          currentSeat: 1,
          updatedAt: new Date("2025-01-01T00:00:00Z"),
        },
        data: { currentSeat: 1 },
      });
      expect(tx.match.update).not.toHaveBeenCalled();
      expectNoSecret(result);
    });

    it("feeds the AI only with its own moves, per difficulty", async () => {
      const aiMoves = [{ guess: "2468", picos: 1, palas: 1 }];
      const humanMoves = [{ guess: "1111", picos: 9, palas: 9 }];
      const build = (difficulty: Difficulty) => {
        const participants = makeParticipants();
        participants[0].moves = humanMoves;
        participants[0].attemptsUsed = 1;
        participants[1].moves = aiMoves;
        participants[1].attemptsUsed = 1;
        return makeMatchRow({ participants, aiDifficulty: difficulty });
      };

      prisma.match.findUnique.mockResolvedValue(build(Difficulty.EASY));
      await service.submitMove("p1", "m1", "1357");
      expect(ai.easyMove).toHaveBeenCalledWith(["2468"]);

      prisma.match.findUnique.mockResolvedValue(build(Difficulty.MEDIUM));
      await service.submitMove("p1", "m1", "1357");
      expect(ai.mediumMove).toHaveBeenCalledWith(aiMoves);

      prisma.match.findUnique.mockResolvedValue(build(Difficulty.HARD));
      await service.submitMove("p1", "m1", "1357");
      expect(ai.hardMove).toHaveBeenCalledWith(aiMoves);
    });

    it("falls back to an unused easy move when the AI repeats a guess", async () => {
      const participants = makeParticipants();
      participants[1].moves = [{ guess: "9876", picos: 0, palas: 0 }];
      participants[1].attemptsUsed = 1;
      prisma.match.findUnique.mockResolvedValue(
        makeMatchRow({ participants, aiDifficulty: Difficulty.HARD }),
      );
      ai.hardMove.mockReturnValue("9876");
      ai.easyMove.mockReturnValue("4321");

      const result = await service.submitMove("p1", "m1", "1357");

      expect(result.aiMove?.guess).toBe("4321");
    });

    it("finishes the match with the human as winner and the AI does not play", async () => {
      prisma.match.findUnique.mockResolvedValue(makeMatchRow());
      tx.matchParticipant.findMany.mockResolvedValue([
        { id: "part-1", seat: 1, playerId: "p1", isAi: false, attemptsUsed: 1 },
        { id: "part-2", seat: 2, playerId: null, isAi: true, attemptsUsed: 0 },
      ]);
      tx.move.groupBy.mockResolvedValue([
        { participantId: "part-1", _sum: { picos: 4, palas: 0 } },
      ]);

      const result = await service.submitMove("p1", "m1", AI_SECRET);

      expect(ai.easyMove).not.toHaveBeenCalled();
      expect(result.aiMove).toBeUndefined();
      expect(result.matchStatus).toBe(MatchStatus.FINISHED);
      expect(result.endReason).toBe(EndReason.GUESSED);
      expect(result.winnerId).toBe("p1");
      expect(result.currentSeat).toBeNull();
      expect(tx.match.update).toHaveBeenCalledWith({
        where: { id: "m1" },
        data: expect.objectContaining({
          status: MatchStatus.FINISHED,
          endReason: EndReason.GUESSED,
          currentSeat: null,
        }),
      });
      expect(stats.recordResult).toHaveBeenCalledTimes(1);
      expect(stats.recordResult).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({
          playerId: "p1",
          mode: GameMode.VERSUS_AI,
          result: MatchResult.WIN,
          attemptsUsed: 1,
          totalPicos: 4,
          totalPalas: 0,
        }),
      );
      // The winning guess IS the rival secret and is echoed in move.guess by
      // design (the player just typed it); assert nothing else leaks it.
      expect(Object.keys(result.move).sort()).toEqual(
        [
          "createdAt",
          "guess",
          "id",
          "isAi",
          "isWin",
          "matchId",
          "palas",
          "picos",
          "playerId",
          "seat",
          "turnNumber",
        ].sort(),
      );
    });

    it("makes the AI the winner when its reply guesses the human secret", async () => {
      prisma.match.findUnique.mockResolvedValue(makeMatchRow());
      ai.easyMove.mockReturnValue(HUMAN_SECRET);
      tx.matchParticipant.findMany.mockResolvedValue([
        { id: "part-1", seat: 1, playerId: "p1", isAi: false, attemptsUsed: 1 },
        { id: "part-2", seat: 2, playerId: null, isAi: true, attemptsUsed: 1 },
      ]);

      const result = await service.submitMove("p1", "m1", "9871");

      expect(result.matchStatus).toBe(MatchStatus.FINISHED);
      expect(result.winnerId).toBeNull(); // AI has no playerId
      expect(stats.recordResult).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ result: MatchResult.LOSS }),
      );
    });

    it("declares a draw when both sides exhaust maxTurns", async () => {
      const participants = makeParticipants();
      participants[0].attemptsUsed = 11;
      participants[1].attemptsUsed = 11;
      prisma.match.findUnique.mockResolvedValue(makeMatchRow({ participants }));
      tx.matchParticipant.findMany.mockResolvedValue([
        {
          id: "part-1",
          seat: 1,
          playerId: "p1",
          isAi: false,
          attemptsUsed: 12,
        },
        { id: "part-2", seat: 2, playerId: null, isAi: true, attemptsUsed: 12 },
      ]);

      const result = await service.submitMove("p1", "m1", "9871");

      expect(result.matchStatus).toBe(MatchStatus.FINISHED);
      expect(result.endReason).toBe(EndReason.MAX_TURNS);
      expect(stats.recordResult).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ result: MatchResult.DRAW }),
      );
    });

    it("answers 409 when the optimistic claim fails", async () => {
      prisma.match.findUnique.mockResolvedValue(makeMatchRow());
      tx.match.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.submitMove("p1", "m1", "1357")).rejects.toThrow(
        "Match state changed, retry the move",
      );
      expect(tx.move.create).not.toHaveBeenCalled();
    });

    it("translates a unique violation into a 409", async () => {
      prisma.match.findUnique.mockResolvedValue(makeMatchRow());
      tx.move.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("dup", {
          code: "P2002",
          clientVersion: "test",
        }),
      );

      await expect(service.submitMove("p1", "m1", "1357")).rejects.toThrow(
        "Move already submitted for this turn",
      );
    });

    it("rethrows unexpected transaction errors", async () => {
      prisma.match.findUnique.mockResolvedValue(makeMatchRow());
      const boom = new Error("db down");
      tx.move.create.mockRejectedValue(boom);

      await expect(service.submitMove("p1", "m1", "1357")).rejects.toBe(boom);
    });
  });

  describe("submitMove human versus human", () => {
    const pvpMatch = (overrides: Record<string, unknown> = {}) => {
      const participants = makeParticipants();
      participants[1] = {
        ...participants[1],
        playerId: "p2",
        isAi: false,
      };
      return makeMatchRow({
        mode: GameMode.GLOBAL,
        isRanked: true,
        participants,
        ...overrides,
      });
    };

    it("passes the turn to the opponent without AI involvement", async () => {
      prisma.match.findUnique.mockResolvedValue(pvpMatch());

      const result = await service.submitMove("p1", "m1", "5671");

      expect(result.aiMove).toBeUndefined();
      expect(result.currentSeat).toBe(2);
      expect(result.nextTurn).toBe(2);
      expect(ai.easyMove).not.toHaveBeenCalled();
      expectNoSecret(result);
    });

    it("updates ELO of both players on a ranked win", async () => {
      prisma.match.findUnique.mockResolvedValue(pvpMatch());
      tx.matchParticipant.findMany.mockResolvedValue([
        { id: "part-1", seat: 1, playerId: "p1", isAi: false, attemptsUsed: 1 },
        { id: "part-2", seat: 2, playerId: "p2", isAi: false, attemptsUsed: 0 },
      ]);
      tx.$queryRaw.mockResolvedValue([
        { id: "p1", elo: 1000 },
        { id: "p2", elo: 1000 },
      ]);

      const result = await service.submitMove("p1", "m1", AI_SECRET);

      expect(result.winnerId).toBe("p1");
      expect(tx.player.update).toHaveBeenCalledWith({
        where: { id: "p1" },
        data: { elo: 1016, rank: "PLATA" },
      });
      expect(tx.player.update).toHaveBeenCalledWith({
        where: { id: "p2" },
        data: { elo: 984, rank: "BRONCE" },
      });
      expect(tx.matchParticipant.update).toHaveBeenCalledWith({
        where: { id: "part-1" },
        data: expect.objectContaining({
          result: MatchResult.WIN,
          eloBefore: 1000,
          eloAfter: 1016,
        }),
      });
      expect(stats.recordResult).toHaveBeenCalledTimes(2);
    });

    it("does not touch ELO for unranked matches and closes the room", async () => {
      prisma.match.findUnique.mockResolvedValue(
        pvpMatch({ isRanked: false, mode: GameMode.PRIVATE, roomId: "room-1" }),
      );
      tx.matchParticipant.findMany.mockResolvedValue([
        { id: "part-1", seat: 1, playerId: "p1", isAi: false, attemptsUsed: 1 },
        { id: "part-2", seat: 2, playerId: "p2", isAi: false, attemptsUsed: 0 },
      ]);

      await service.submitMove("p1", "m1", AI_SECRET);

      expect(tx.player.update).not.toHaveBeenCalled();
      expect(tx.room.updateMany).toHaveBeenCalledWith({
        where: { id: "room-1" },
        data: { status: "CLOSED" },
      });
    });

    it("skips ELO when a locked rating row is missing", async () => {
      prisma.match.findUnique.mockResolvedValue(pvpMatch());
      tx.matchParticipant.findMany.mockResolvedValue([
        { id: "part-1", seat: 1, playerId: "p1", isAi: false, attemptsUsed: 1 },
        { id: "part-2", seat: 2, playerId: "p2", isAi: false, attemptsUsed: 0 },
      ]);
      tx.$queryRaw.mockResolvedValue([{ id: "p1", elo: 1000 }]);

      await service.submitMove("p1", "m1", AI_SECRET);

      expect(tx.player.update).not.toHaveBeenCalled();
    });
  });

  describe("createMatch", () => {
    const summaryRow = {
      id: "m1",
      mode: GameMode.VERSUS_AI,
      status: MatchStatus.PLAYING,
      endReason: null,
      source: "LIVE",
      isRanked: false,
      maxTurns: 12,
      aiDifficulty: Difficulty.EASY,
      startingSeat: 1,
      currentSeat: 1,
      turnDeadlineAt: null,
      roomId: null,
      startedAt: new Date(),
      finishedAt: null,
      createdAt: new Date(),
      participants: [
        {
          id: "part-1",
          seat: 1,
          playerId: "p1",
          isAi: false,
          result: null,
          attemptsUsed: 0,
        },
        {
          id: "part-2",
          seat: 2,
          playerId: null,
          isAi: true,
          result: null,
          attemptsUsed: 0,
        },
      ],
    };

    it("rejects non VERSUS_AI modes", async () => {
      await expect(
        service.createMatch("p1", { mode: "GLOBAL" }),
      ).rejects.toThrow(BadRequestException);
    });

    it("returns only the creator secret, never the AI one", async () => {
      prisma.match.create.mockResolvedValue({ id: "m1" });
      prisma.match.findUnique.mockResolvedValue(summaryRow);

      const view = await service.createMatch("p1", {
        mode: "VERSUS_AI",
        maxTurns: 12,
      });

      expect(view.player1Number).toBe(HUMAN_SECRET);
      expect(view.player2Number).toBeUndefined();
      expectNoSecret(view);
      expect(JSON.stringify(view)).not.toContain("secretNumber");
      expect(prisma.match.create.mock.calls[0][0].data.aiDifficulty).toBe(
        Difficulty.EASY,
      );
    });
  });

  describe("getMatch", () => {
    const base = {
      id: "m1",
      mode: GameMode.GLOBAL,
      status: MatchStatus.PLAYING,
      endReason: null,
      source: "LIVE",
      isRanked: true,
      maxTurns: 12,
      aiDifficulty: null,
      startingSeat: 1,
      currentSeat: 1,
      turnDeadlineAt: null,
      roomId: null,
      startedAt: new Date(),
      finishedAt: null,
      createdAt: new Date(),
      participants: [
        {
          id: "part-1",
          seat: 1,
          playerId: "p1",
          isAi: false,
          result: null,
          attemptsUsed: 1,
        },
        {
          id: "part-2",
          seat: 2,
          playerId: "p2",
          isAi: false,
          result: null,
          attemptsUsed: 1,
        },
      ],
    };

    it("rejects viewers that are not participants", async () => {
      prisma.match.findUnique.mockResolvedValue(base);
      await expect(service.getMatch("intruder", "m1")).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("throws 404 for an unknown match", async () => {
      prisma.match.findUnique.mockResolvedValue(null);
      await expect(service.getMatch("p1", "m1")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("exposes only the viewer secret and moves without secrets", async () => {
      prisma.match.findUnique.mockResolvedValue(base);
      prisma.move.findMany.mockResolvedValue([
        moveRow("part-1", 1, "1357", 1, 1),
        moveRow("part-2", 1, "2468", 0, 2),
      ]);
      prisma.matchParticipant.findUnique.mockResolvedValue({
        secretNumber: HUMAN_SECRET,
      });

      const view = await service.getMatch("p1", "m1");

      expect(view.mySeat).toBe(1);
      expect(view.player1Number).toBe(HUMAN_SECRET);
      expect(view.player2Number).toBeUndefined();
      expect(view.moves).toHaveLength(2);
      expect(view.moves[1]).toMatchObject({ playerId: "p2", seat: 2 });
      expect(view.turnCount).toBe(2);
      expect(view.currentTurn).toBe(3);
      expectNoSecret(view);
      expect(JSON.stringify(view)).not.toContain("secretNumber");
    });

    it("exposes the seat-2 secret to the seat-2 viewer only", async () => {
      prisma.match.findUnique.mockResolvedValue(base);
      prisma.matchParticipant.findUnique.mockResolvedValue({
        secretNumber: AI_SECRET,
      });

      const view = await service.getMatch("p2", "m1");

      expect(view.player2Number).toBe(AI_SECRET);
      expect(view.player1Number).toBeUndefined();
      expectNoSecret(view, HUMAN_SECRET);
    });
  });

  describe("forfeitMatch", () => {
    const forfeitRow = (overrides: Record<string, unknown> = {}) => ({
      id: "m1",
      mode: GameMode.GLOBAL,
      status: MatchStatus.PLAYING,
      isRanked: true,
      roomId: null,
      startedAt: new Date(),
      participants: [
        { seat: 1, playerId: "p1" },
        { seat: 2, playerId: "p2" },
      ],
      ...overrides,
    });
    const summary = {
      id: "m1",
      mode: GameMode.GLOBAL,
      status: MatchStatus.FINISHED,
      participants: [
        {
          id: "a",
          seat: 1,
          playerId: "p1",
          isAi: false,
          result: "LOSS",
          attemptsUsed: 0,
        },
        {
          id: "b",
          seat: 2,
          playerId: "p2",
          isAi: false,
          result: "WIN",
          attemptsUsed: 0,
        },
      ],
    };

    it("throws 404 for an unknown match", async () => {
      prisma.match.findUnique.mockResolvedValueOnce(null);
      await expect(service.forfeitMatch("p1", "m1")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws 403 for non participants", async () => {
      prisma.match.findUnique.mockResolvedValueOnce(forfeitRow());
      await expect(service.forfeitMatch("x", "m1")).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("returns the summary without changes when already finished", async () => {
      prisma.match.findUnique
        .mockResolvedValueOnce(forfeitRow({ status: MatchStatus.FINISHED }))
        .mockResolvedValueOnce(summary);

      await service.forfeitMatch("p1", "m1");

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("throws 409 when the match is not in progress", async () => {
      prisma.match.findUnique.mockResolvedValueOnce(
        forfeitRow({ status: MatchStatus.WAITING }),
      );
      await expect(service.forfeitMatch("p1", "m1")).rejects.toThrow(
        "Match is not in progress",
      );
    });

    it("makes the opponent the winner", async () => {
      prisma.match.findUnique
        .mockResolvedValueOnce(forfeitRow())
        .mockResolvedValueOnce(summary);
      tx.matchParticipant.findMany.mockResolvedValue([
        { id: "a", seat: 1, playerId: "p1", isAi: false, attemptsUsed: 0 },
        { id: "b", seat: 2, playerId: "p2", isAi: false, attemptsUsed: 0 },
      ]);
      tx.$queryRaw.mockResolvedValue([
        { id: "p1", elo: 1000 },
        { id: "p2", elo: 1000 },
      ]);

      const view = await service.forfeitMatch("p1", "m1");

      expect(tx.match.update).toHaveBeenCalledWith({
        where: { id: "m1" },
        data: expect.objectContaining({ endReason: EndReason.ABANDONED }),
      });
      expect(tx.matchParticipant.update).toHaveBeenCalledWith({
        where: { id: "a" },
        data: expect.objectContaining({ result: MatchResult.LOSS }),
      });
      expectNoSecret(view);
    });

    it("does nothing when another request already finished the match", async () => {
      prisma.match.findUnique
        .mockResolvedValueOnce(forfeitRow())
        .mockResolvedValueOnce(summary);
      tx.match.updateMany.mockResolvedValue({ count: 0 });

      await service.forfeitMatch("p1", "m1");

      expect(tx.match.update).not.toHaveBeenCalled();
    });
  });

  describe("lookups", () => {
    it("isParticipant reflects the participant row", async () => {
      prisma.matchParticipant.findFirst.mockResolvedValueOnce({ id: "x" });
      await expect(service.isParticipant("p1", "m1")).resolves.toBe(true);
      prisma.matchParticipant.findFirst.mockResolvedValueOnce(null);
      await expect(service.isParticipant("p9", "m1")).resolves.toBe(false);
    });

    it("getActiveMatchByPlayer returns null when nothing is active", async () => {
      prisma.match.findFirst.mockResolvedValue(null);
      await expect(service.getActiveMatchByPlayer("p1")).resolves.toBeNull();
    });
  });
});

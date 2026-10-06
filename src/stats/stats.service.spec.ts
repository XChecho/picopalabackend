import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  Difficulty,
  EndReason,
  GameMode,
  MatchResult,
  Prisma,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { OfflineMatchDto } from "./dto/sync-stats.dto";
import { IRecordResultInput, StatsService } from "./stats.service";

interface ITxMock {
  playerStats: {
    upsert: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    update: jest.Mock;
  };
  match: { create: jest.Mock };
}

const asTx = (tx: ITxMock): Prisma.TransactionClient =>
  tx as unknown as Prisma.TransactionClient;

const makeTx = (): ITxMock => ({
  playerStats: {
    upsert: jest.fn().mockResolvedValue({}),
    findUniqueOrThrow: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
  },
  match: { create: jest.fn().mockResolvedValue({ id: "match-new" }) },
});

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";

const makeDto = (
  overrides: Partial<OfflineMatchDto> = {},
): OfflineMatchDto => ({
  clientMatchId: CLIENT_ID,
  aiDifficulty: Difficulty.EASY,
  result: MatchResult.WIN,
  attemptsUsed: 5,
  totalPicos: 8,
  totalPalas: 6,
  durationSec: 120,
  ...overrides,
});

describe("StatsService", () => {
  let service: StatsService;
  let prisma: { match: { findUnique: jest.Mock }; $transaction: jest.Mock };
  let tx: ITxMock;

  beforeEach(() => {
    tx = makeTx();
    prisma = {
      match: { findUnique: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn((fn: (t: Prisma.TransactionClient) => unknown) =>
        fn(asTx(tx)),
      ),
    };
    service = new StatsService(prisma as unknown as PrismaService);
  });

  describe("recordResult", () => {
    const input = (overrides: Partial<IRecordResultInput> = {}) => ({
      playerId: "p1",
      mode: GameMode.VERSUS_AI,
      result: MatchResult.WIN,
      attemptsUsed: 6,
      totalPicos: 9,
      totalPalas: 7,
      durationSec: 90,
      ...overrides,
    });

    it("creates the first row with a streak of 1 and one win", async () => {
      tx.playerStats.findUniqueOrThrow.mockResolvedValue({
        currentStreak: 1,
        bestStreak: 0,
        bestAttempts: null,
      });

      await service.recordResult(asTx(tx), input());

      const arg = tx.playerStats.upsert.mock.calls[0][0];
      expect(arg.where).toEqual({
        playerId_mode: { playerId: "p1", mode: GameMode.VERSUS_AI },
      });
      expect(arg.create).toMatchObject({
        games: 1,
        wins: 1,
        losses: 0,
        draws: 0,
        currentStreak: 1,
        totalAttempts: 6,
        totalPicos: 9,
        totalPalas: 7,
        totalDurationSec: 90,
      });
      expect(tx.playerStats.update).toHaveBeenCalledWith({
        where: { playerId_mode: { playerId: "p1", mode: GameMode.VERSUS_AI } },
        data: { bestStreak: 1, bestAttempts: 6 },
      });
    });

    it("increments the streak on a win", async () => {
      tx.playerStats.findUniqueOrThrow.mockResolvedValue({
        currentStreak: 3,
        bestStreak: 2,
        bestAttempts: 4,
      });

      await service.recordResult(asTx(tx), input({ attemptsUsed: 6 }));

      expect(tx.playerStats.upsert.mock.calls[0][0].update).toMatchObject({
        wins: { increment: 1 },
        currentStreak: { increment: 1 },
      });
      // bestStreak updated, bestAttempts (6 >= 4) untouched
      expect(tx.playerStats.update.mock.calls[0][0].data).toEqual({
        bestStreak: 3,
      });
    });

    it("improves bestAttempts only when strictly lower", async () => {
      tx.playerStats.findUniqueOrThrow.mockResolvedValue({
        currentStreak: 1,
        bestStreak: 5,
        bestAttempts: 7,
      });

      await service.recordResult(asTx(tx), input({ attemptsUsed: 6 }));

      expect(tx.playerStats.update.mock.calls[0][0].data).toEqual({
        bestAttempts: 6,
      });
    });

    it("does not touch bestAttempts when attempts equal the record", async () => {
      tx.playerStats.findUniqueOrThrow.mockResolvedValue({
        currentStreak: 1,
        bestStreak: 5,
        bestAttempts: 6,
      });

      await service.recordResult(asTx(tx), input({ attemptsUsed: 6 }));

      expect(tx.playerStats.update).not.toHaveBeenCalled();
    });

    it("resets the streak on a loss and never sets bestAttempts", async () => {
      tx.playerStats.findUniqueOrThrow.mockResolvedValue({
        currentStreak: 0,
        bestStreak: 4,
        bestAttempts: null,
      });

      await service.recordResult(
        asTx(tx),
        input({ result: MatchResult.LOSS, attemptsUsed: 2 }),
      );

      const arg = tx.playerStats.upsert.mock.calls[0][0];
      expect(arg.update).toMatchObject({
        wins: { increment: 0 },
        losses: { increment: 1 },
        draws: { increment: 0 },
        currentStreak: 0,
      });
      expect(arg.create).toMatchObject({ losses: 1, currentStreak: 0 });
      expect(tx.playerStats.update).not.toHaveBeenCalled();
    });

    it("resets the streak on a draw", async () => {
      tx.playerStats.findUniqueOrThrow.mockResolvedValue({
        currentStreak: 0,
        bestStreak: 0,
        bestAttempts: null,
      });

      await service.recordResult(asTx(tx), input({ result: MatchResult.DRAW }));

      const arg = tx.playerStats.upsert.mock.calls[0][0];
      expect(arg.update).toMatchObject({
        draws: { increment: 1 },
        currentStreak: 0,
      });
      expect(arg.create).toMatchObject({ draws: 1, currentStreak: 0 });
      expect(tx.playerStats.update).not.toHaveBeenCalled();
    });
  });

  describe("syncOfflineMatches", () => {
    it("creates a finished OFFLINE_SYNC match with a human and an AI participant", async () => {
      tx.playerStats.findUniqueOrThrow.mockResolvedValue({
        currentStreak: 1,
        bestStreak: 1,
        bestAttempts: 5,
      });
      const finishedAt = "2025-06-01T10:00:00.000Z";

      const result = await service.syncOfflineMatches("p1", [
        makeDto({ finishedAt }),
      ]);

      expect(result).toEqual({
        message: "Stats synced successfully",
        synced: 1,
        duplicates: 0,
        results: [
          {
            clientMatchId: CLIENT_ID,
            matchId: "match-new",
            status: "created",
            result: MatchResult.WIN,
          },
        ],
      });
      const data = tx.match.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        mode: GameMode.VERSUS_AI,
        status: "FINISHED",
        endReason: EndReason.GUESSED,
        source: "OFFLINE_SYNC",
        isRanked: false,
        maxTurns: 12,
        clientMatchId: CLIENT_ID,
      });
      expect(data.startedAt).toEqual(new Date("2025-06-01T09:58:00.000Z"));
      expect(data.participants.create).toEqual([
        { seat: 1, playerId: "p1", result: "WIN", attemptsUsed: 5 },
        { seat: 2, isAi: true, result: "LOSS" },
      ]);
    });

    it("uses MAX_TURNS as end reason for draws and mirrors the AI result", async () => {
      tx.playerStats.findUniqueOrThrow.mockResolvedValue({
        currentStreak: 0,
        bestStreak: 0,
        bestAttempts: null,
      });

      await service.syncOfflineMatches("p1", [
        makeDto({ result: MatchResult.DRAW, totalPicos: 0, totalPalas: 0 }),
      ]);

      const data = tx.match.create.mock.calls[0][0].data;
      expect(data.endReason).toBe(EndReason.MAX_TURNS);
      expect(data.participants.create[1].result).toBe("DRAW");
    });

    it("mirrors a loss as an AI win", async () => {
      tx.playerStats.findUniqueOrThrow.mockResolvedValue({
        currentStreak: 0,
        bestStreak: 0,
        bestAttempts: null,
      });

      await service.syncOfflineMatches("p1", [
        makeDto({ result: MatchResult.LOSS }),
      ]);

      expect(
        tx.match.create.mock.calls[0][0].data.participants.create[1].result,
      ).toBe("WIN");
    });

    it("is idempotent: an existing match of the same player is returned as duplicate", async () => {
      prisma.match.findUnique.mockResolvedValue({
        id: "match-old",
        participants: [{ playerId: "p1", result: MatchResult.LOSS }],
      });

      const result = await service.syncOfflineMatches("p1", [makeDto()]);

      expect(result.synced).toBe(0);
      expect(result.duplicates).toBe(1);
      expect(result.results[0]).toEqual({
        clientMatchId: CLIENT_ID,
        matchId: "match-old",
        status: "duplicate",
        result: MatchResult.LOSS,
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it("falls back to the DTO result when the stored participant has none", async () => {
      prisma.match.findUnique.mockResolvedValue({
        id: "match-old",
        participants: [{ playerId: "p1", result: null }],
      });

      const result = await service.syncOfflineMatches("p1", [makeDto()]);

      expect(result.results[0].result).toBe(MatchResult.WIN);
    });

    it("answers 409 when the clientMatchId belongs to another player", async () => {
      prisma.match.findUnique.mockResolvedValue({
        id: "match-old",
        participants: [{ playerId: "other", result: MatchResult.WIN }],
      });

      await expect(
        service.syncOfflineMatches("p1", [makeDto()]),
      ).rejects.toThrow(ConflictException);
    });

    it("answers 409 when the existing match has no seat-1 participant", async () => {
      prisma.match.findUnique.mockResolvedValue({
        id: "match-old",
        participants: [],
      });

      await expect(
        service.syncOfflineMatches("p1", [makeDto()]),
      ).rejects.toThrow(ConflictException);
    });

    it("recovers from a lost unique race by returning the duplicate", async () => {
      prisma.match.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: "match-raced",
          participants: [{ playerId: "p1", result: MatchResult.WIN }],
        });
      prisma.$transaction.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("dup", {
          code: "P2002",
          clientVersion: "test",
        }),
      );

      const result = await service.syncOfflineMatches("p1", [makeDto()]);

      expect(result.results[0].status).toBe("duplicate");
      expect(result.results[0].matchId).toBe("match-raced");
    });

    it("rethrows a unique violation if the winning row cannot be found", async () => {
      const error = new Prisma.PrismaClientKnownRequestError("dup", {
        code: "P2002",
        clientVersion: "test",
      });
      prisma.$transaction.mockRejectedValue(error);

      await expect(service.syncOfflineMatches("p1", [makeDto()])).rejects.toBe(
        error,
      );
    });

    it("rethrows non-unique errors", async () => {
      const error = new Error("boom");
      prisma.$transaction.mockRejectedValue(error);

      await expect(service.syncOfflineMatches("p1", [makeDto()])).rejects.toBe(
        error,
      );
    });

    it("rejects repeated clientMatchId inside one request", async () => {
      await expect(
        service.syncOfflineMatches("p1", [makeDto(), makeDto()]),
      ).rejects.toThrow("Duplicate clientMatchId in request");
    });

    describe("plausibility", () => {
      const expectRejected = async (
        dto: OfflineMatchDto,
        message: string,
      ): Promise<void> => {
        const error = await service
          .syncOfflineMatches("p1", [dto])
          .catch((e) => e);
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).message).toBe(message);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      };

      it("rejects attemptsUsed above the default maxTurns (12)", async () => {
        await expectRejected(
          makeDto({ attemptsUsed: 13, totalPicos: 4, totalPalas: 0 }),
          "attemptsUsed exceeds maxTurns",
        );
      });

      it("rejects attemptsUsed above a custom maxTurns", async () => {
        await expectRejected(
          makeDto({ attemptsUsed: 6, maxTurns: 5 }),
          "attemptsUsed exceeds maxTurns",
        );
      });

      it("rejects picos + palas above 4 * attempts", async () => {
        await expectRejected(
          makeDto({ attemptsUsed: 2, totalPicos: 6, totalPalas: 3 }),
          "totalPicos + totalPalas out of range",
        );
      });

      it("rejects a win with fewer than 4 total picos", async () => {
        await expectRejected(
          makeDto({ totalPicos: 3, totalPalas: 2 }),
          "A win requires at least 4 picos",
        );
      });

      it("rejects finishedAt far in the future", async () => {
        await expectRejected(
          makeDto({
            finishedAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          }),
          "finishedAt cannot be in the future",
        );
      });

      it("accepts boundary values (4*attempts total, 4 picos, small clock skew)", async () => {
        tx.playerStats.findUniqueOrThrow.mockResolvedValue({
          currentStreak: 1,
          bestStreak: 1,
          bestAttempts: 1,
        });

        const result = await service.syncOfflineMatches("p1", [
          makeDto({
            attemptsUsed: 1,
            totalPicos: 4,
            totalPalas: 0,
            finishedAt: new Date(Date.now() + 60 * 1000).toISOString(),
          }),
        ]);

        expect(result.synced).toBe(1);
      });
    });
  });
});

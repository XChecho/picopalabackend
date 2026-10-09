import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { EndReason, GameMode, MatchResult, Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { OfflineMatchDto } from "./dto/sync-stats.dto";

const DEFAULT_MAX_TURNS = 12;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const PRISMA_UNIQUE_VIOLATION = "P2002";

export interface IRecordResultInput {
  playerId: string;
  mode: GameMode;
  result: MatchResult;
  attemptsUsed: number;
  totalPicos: number;
  totalPalas: number;
  durationSec: number;
}

export interface ISyncMatchResult {
  clientMatchId: string;
  matchId: string;
  status: "created" | "duplicate";
  result: MatchResult;
}

@Injectable()
export class StatsService {
  constructor(private readonly prismaService: PrismaService) {}

  /**
   * Applies one finished match to the player's per-mode stats.
   * Must run inside the transaction that finishes the match. The upsert takes
   * the row lock, so the follow-up read/update of best* fields is race-free.
   */
  async recordResult(
    tx: Prisma.TransactionClient,
    input: IRecordResultInput,
  ): Promise<void> {
    const isWin = input.result === MatchResult.WIN;
    const key = { playerId: input.playerId, mode: input.mode };

    await tx.playerStats.upsert({
      where: { playerId_mode: key },
      create: {
        ...key,
        games: 1,
        wins: isWin ? 1 : 0,
        losses: input.result === MatchResult.LOSS ? 1 : 0,
        draws: input.result === MatchResult.DRAW ? 1 : 0,
        currentStreak: isWin ? 1 : 0,
        totalAttempts: input.attemptsUsed,
        totalPicos: input.totalPicos,
        totalPalas: input.totalPalas,
        totalDurationSec: input.durationSec,
      },
      update: {
        games: { increment: 1 },
        wins: { increment: isWin ? 1 : 0 },
        losses: { increment: input.result === MatchResult.LOSS ? 1 : 0 },
        draws: { increment: input.result === MatchResult.DRAW ? 1 : 0 },
        currentStreak: isWin ? { increment: 1 } : 0,
        totalAttempts: { increment: input.attemptsUsed },
        totalPicos: { increment: input.totalPicos },
        totalPalas: { increment: input.totalPalas },
        totalDurationSec: { increment: input.durationSec },
      },
    });

    const current = await tx.playerStats.findUniqueOrThrow({
      where: { playerId_mode: key },
      select: { currentStreak: true, bestStreak: true, bestAttempts: true },
    });

    const data: Prisma.PlayerStatsUpdateInput = {};
    if (current.currentStreak > current.bestStreak) {
      data.bestStreak = current.currentStreak;
    }
    if (
      isWin &&
      (current.bestAttempts === null ||
        input.attemptsUsed < current.bestAttempts)
    ) {
      data.bestAttempts = input.attemptsUsed;
    }
    if (Object.keys(data).length > 0) {
      await tx.playerStats.update({
        where: { playerId_mode: key },
        data,
      });
    }
  }

  /**
   * Idempotent sync of matches played offline against the AI.
   * Each match is persisted in its own transaction keyed by clientMatchId.
   */
  async syncOfflineMatches(playerId: string, matches: OfflineMatchDto[]) {
    const ids = matches.map((m) => m.clientMatchId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException("Duplicate clientMatchId in request");
    }
    matches.forEach((m) => this.assertPlausible(m));

    const results: ISyncMatchResult[] = [];
    for (const match of matches) {
      results.push(await this.syncOne(playerId, match));
    }

    const created = results.filter((r) => r.status === "created").length;
    return {
      message: "Stats synced successfully",
      synced: created,
      duplicates: results.length - created,
      results,
    };
  }

  private async syncOne(
    playerId: string,
    dto: OfflineMatchDto,
  ): Promise<ISyncMatchResult> {
    const existing = await this.findExisting(playerId, dto);
    if (existing) return existing;

    const maxTurns = dto.maxTurns ?? DEFAULT_MAX_TURNS;
    const finishedAt = dto.finishedAt ? new Date(dto.finishedAt) : new Date();
    const startedAt = new Date(finishedAt.getTime() - dto.durationSec * 1000);

    const playerParticipantId = randomUUID();
    const aiParticipantId = randomUUID();

    try {
      return await this.prismaService.$transaction(async (tx) => {
        const created = await tx.match.create({
          data: {
            mode: GameMode.VERSUS_AI,
            status: "FINISHED",
            endReason: this.endReasonFor(dto),
            source: "OFFLINE_SYNC",
            clientMatchId: dto.clientMatchId,
            isRanked: false,
            maxTurns,
            aiDifficulty: dto.aiDifficulty,
            startedAt,
            finishedAt,
            participants: {
              create: [
                {
                  id: playerParticipantId,
                  seat: 1,
                  playerId,
                  result: dto.result,
                  attemptsUsed: dto.attemptsUsed,
                  ...(dto.playerSecret && { secretNumber: dto.playerSecret }),
                },
                {
                  id: aiParticipantId,
                  seat: 2,
                  isAi: true,
                  result: this.opposite(dto.result),
                  ...(dto.aiSecret && { secretNumber: dto.aiSecret }),
                },
              ],
            },
          },
          select: { id: true },
        });

        if (dto.moves?.length) {
          await tx.move.createMany({
            data: dto.moves.map((move, index) => ({
              matchId: created.id,
              participantId:
                move.seat === 1 ? playerParticipantId : aiParticipantId,
              turnNumber: move.turnNumber,
              guess: move.guess,
              picos: move.picos,
              palas: move.palas,
              isWin: move.isWin,
              // Array order is chronological; 1ms steps keep replay (createdAt asc) in that order.
              createdAt: new Date(startedAt.getTime() + index),
            })),
          });
        }

        await this.recordResult(tx, {
          playerId,
          mode: GameMode.VERSUS_AI,
          result: dto.result,
          attemptsUsed: dto.attemptsUsed,
          totalPicos: dto.totalPicos,
          totalPalas: dto.totalPalas,
          durationSec: dto.durationSec,
        });

        return {
          clientMatchId: dto.clientMatchId,
          matchId: created.id,
          status: "created" as const,
          result: dto.result,
        };
      });
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        // Lost a race with a concurrent sync of the same match.
        const duplicate = await this.findExisting(playerId, dto);
        if (duplicate) return duplicate;
      }
      throw error;
    }
  }

  private async findExisting(
    playerId: string,
    dto: OfflineMatchDto,
  ): Promise<ISyncMatchResult | null> {
    const match = await this.prismaService.match.findUnique({
      where: { clientMatchId: dto.clientMatchId },
      select: {
        id: true,
        participants: {
          where: { seat: 1 },
          select: { playerId: true, result: true },
        },
      },
    });
    if (!match) return null;

    const owner = match.participants[0];
    if (!owner || owner.playerId !== playerId) {
      throw new ConflictException("clientMatchId already in use");
    }

    return {
      clientMatchId: dto.clientMatchId,
      matchId: match.id,
      status: "duplicate",
      result: owner.result ?? dto.result,
    };
  }

  private assertPlausible(dto: OfflineMatchDto): void {
    const maxTurns = dto.maxTurns ?? DEFAULT_MAX_TURNS;
    if (dto.attemptsUsed > maxTurns) {
      throw new BadRequestException("attemptsUsed exceeds maxTurns");
    }
    if (dto.totalPicos + dto.totalPalas > 4 * dto.attemptsUsed) {
      throw new BadRequestException("totalPicos + totalPalas out of range");
    }
    if (dto.result === MatchResult.WIN && dto.totalPicos < 4) {
      throw new BadRequestException("A win requires at least 4 picos");
    }
    if (dto.moves?.length) this.assertMovesPlausible(dto, maxTurns);
    if (
      dto.finishedAt &&
      new Date(dto.finishedAt).getTime() > Date.now() + CLOCK_SKEW_MS
    ) {
      throw new BadRequestException("finishedAt cannot be in the future");
    }
  }

  private assertMovesPlausible(dto: OfflineMatchDto, maxTurns: number): void {
    const moves = dto.moves ?? [];
    const turns = new Set<string>();
    const guesses = new Set<string>();
    const perSeat = { 1: 0, 2: 0 };

    for (const move of moves) {
      const turnKey = `${move.seat}:${move.turnNumber}`;
      const guessKey = `${move.seat}:${move.guess}`;
      if (turns.has(turnKey) || guesses.has(guessKey)) {
        throw new BadRequestException("Duplicate move in match");
      }
      turns.add(turnKey);
      guesses.add(guessKey);
      perSeat[move.seat]++;

      if (move.turnNumber > maxTurns) {
        throw new BadRequestException("turnNumber exceeds maxTurns");
      }
      if (move.picos + move.palas > 4) {
        throw new BadRequestException("picos + palas out of range");
      }
      if (move.isWin !== (move.picos === 4)) {
        throw new BadRequestException("isWin inconsistent with picos");
      }
    }

    if (perSeat[1] !== dto.attemptsUsed) {
      throw new BadRequestException("moves do not match attemptsUsed");
    }
  }

  private endReasonFor(dto: OfflineMatchDto): EndReason {
    // Equal turns per side: a non-draw means someone guessed the secret.
    return dto.result === MatchResult.DRAW
      ? EndReason.MAX_TURNS
      : EndReason.GUESSED;
  }

  private opposite(result: MatchResult): MatchResult {
    if (result === MatchResult.WIN) return MatchResult.LOSS;
    if (result === MatchResult.LOSS) return MatchResult.WIN;
    return MatchResult.DRAW;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_UNIQUE_VIOLATION
    );
  }
}

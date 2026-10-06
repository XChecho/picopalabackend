import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
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
import { PrismaService } from "../prisma/prisma.service";
import { GameService } from "../game/game.service";
import { AiService } from "../game/ai/ai.service";
import { EloService, IEloOutcome } from "../elo/elo.service";
import { StatsService } from "../stats/stats.service";
import { CreateMatchDto } from "./dto/create-match.dto";

const PRISMA_UNIQUE_VIOLATION = "P2002";
const TX_OPTIONS = { maxWait: 5000, timeout: 15000 } as const;

/** Public projection of a match. Never includes secret numbers. */
const MATCH_SUMMARY_SELECT = Prisma.validator<Prisma.MatchSelect>()({
  id: true,
  mode: true,
  status: true,
  endReason: true,
  source: true,
  isRanked: true,
  maxTurns: true,
  aiDifficulty: true,
  startingSeat: true,
  currentSeat: true,
  turnDeadlineAt: true,
  roomId: true,
  startedAt: true,
  finishedAt: true,
  createdAt: true,
  participants: {
    orderBy: { seat: "asc" },
    select: {
      id: true,
      seat: true,
      playerId: true,
      isAi: true,
      result: true,
      attemptsUsed: true,
    },
  },
});

const MOVE_SELECT = Prisma.validator<Prisma.MoveSelect>()({
  id: true,
  matchId: true,
  participantId: true,
  turnNumber: true,
  guess: true,
  picos: true,
  palas: true,
  isWin: true,
  createdAt: true,
});

type MatchSummaryRow = Prisma.MatchGetPayload<{
  select: typeof MATCH_SUMMARY_SELECT;
}>;
type MoveRow = Prisma.MoveGetPayload<{ select: typeof MOVE_SELECT }>;

interface IParticipantRef {
  id: string;
  seat: number;
  playerId: string | null;
  isAi: boolean;
}

interface IFinishParams {
  matchId: string;
  mode: GameMode;
  isRanked: boolean;
  roomId: string | null;
  startedAt: Date | null;
  /** null means draw. */
  winnerSeat: number | null;
  endReason: EndReason;
}

@Injectable()
export class MatchService {
  constructor(
    private readonly prismaService: PrismaService,
    private readonly gameService: GameService,
    private readonly aiService: AiService,
    private readonly eloService: EloService,
    private readonly statsService: StatsService,
  ) {}

  async createMatch(playerId: string, createMatchDto: CreateMatchDto) {
    if (createMatchDto.mode !== "VERSUS_AI") {
      throw new BadRequestException(
        "POST /match is only for VERSUS_AI mode. Use Room module for PRIVATE/GLOBAL.",
      );
    }

    const created = await this.prismaService.match.create({
      data: {
        mode: GameMode.VERSUS_AI,
        status: MatchStatus.PLAYING,
        maxTurns: createMatchDto.maxTurns,
        aiDifficulty: createMatchDto.aiDifficulty ?? Difficulty.EASY,
        startingSeat: 1,
        currentSeat: 1,
        startedAt: new Date(),
        participants: {
          create: [
            {
              seat: 1,
              playerId,
              secretNumber: this.gameService.generateSecretNumber(),
            },
            {
              seat: 2,
              isAi: true,
              secretNumber: this.gameService.generateSecretNumber(),
            },
          ],
        },
      },
      select: { id: true },
    });

    return this.loadSummary(created.id, playerId);
  }

  async getMatch(playerId: string, matchId: string) {
    const summary = await this.loadSummaryRow(matchId);
    this.assertParticipant(
      summary,
      playerId,
      "Not authorized to view this match",
    );

    const moves = await this.prismaService.move.findMany({
      where: { matchId },
      orderBy: [{ createdAt: "asc" }, { turnNumber: "asc" }],
      select: MOVE_SELECT,
    });

    const view = await this.buildView(summary, playerId);
    return {
      ...view,
      moves: moves.map((m) => this.toMoveView(m, summary.participants)),
    };
  }

  async isParticipant(playerId: string, matchId: string): Promise<boolean> {
    const row = await this.prismaService.matchParticipant.findFirst({
      where: { matchId, playerId },
      select: { id: true },
    });
    return row !== null;
  }

  async forfeitMatch(
    playerId: string,
    matchId: string,
    reason: EndReason = EndReason.ABANDONED,
  ) {
    const match = await this.prismaService.match.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        mode: true,
        status: true,
        isRanked: true,
        roomId: true,
        startedAt: true,
        participants: { select: { seat: true, playerId: true } },
      },
    });

    if (!match) {
      throw new NotFoundException("Match not found");
    }

    const me = match.participants.find((p) => p.playerId === playerId);
    if (!me) {
      throw new ForbiddenException("Not a participant in this match");
    }

    if (match.status === MatchStatus.FINISHED) {
      return this.loadSummary(matchId, playerId);
    }
    if (match.status !== MatchStatus.PLAYING) {
      throw new ConflictException("Match is not in progress");
    }

    const opponent = match.participants.find((p) => p.seat !== me.seat);

    await this.prismaService.$transaction(async (tx) => {
      // Claim the match: only one finisher may win the transition.
      const claim = await tx.match.updateMany({
        where: { id: matchId, status: MatchStatus.PLAYING },
        data: { currentSeat: null },
      });
      if (claim.count !== 1) return;

      await this.finishMatch(tx, {
        matchId,
        mode: match.mode,
        isRanked: match.isRanked,
        roomId: match.roomId,
        startedAt: match.startedAt,
        winnerSeat: opponent?.seat ?? null,
        endReason: reason,
      });
    }, TX_OPTIONS);

    return this.loadSummary(matchId, playerId);
  }

  async getActiveMatchByPlayer(playerId: string) {
    const match = await this.prismaService.match.findFirst({
      where: {
        status: MatchStatus.PLAYING,
        participants: { some: { playerId } },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    return match ? this.loadSummary(match.id, playerId) : null;
  }

  async submitMove(playerId: string, matchId: string, guess: string) {
    const validation = this.gameService.validateGuess(guess);
    if (!validation.valid) {
      throw new BadRequestException(validation.error);
    }

    // secretNumber is selected for BOTH seats because the server needs the
    // rival's secret to score the guess. It is never copied into a response.
    const match = await this.prismaService.match.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        mode: true,
        status: true,
        isRanked: true,
        maxTurns: true,
        aiDifficulty: true,
        currentSeat: true,
        roomId: true,
        startedAt: true,
        updatedAt: true,
        participants: {
          orderBy: { seat: "asc" },
          select: {
            id: true,
            seat: true,
            playerId: true,
            isAi: true,
            secretNumber: true,
            attemptsUsed: true,
            moves: {
              orderBy: { turnNumber: "asc" },
              select: { guess: true, picos: true, palas: true },
            },
          },
        },
      },
    });

    if (!match) {
      throw new NotFoundException("Match not found");
    }

    const me = match.participants.find((p) => p.playerId === playerId);
    if (!me) {
      throw new ForbiddenException("Not authorized to play in this match");
    }

    if (
      match.status === MatchStatus.FINISHED ||
      match.status === MatchStatus.CANCELLED
    ) {
      throw new ConflictException("Match already finished");
    }

    const opponent = match.participants.find((p) => p.seat !== me.seat);
    if (
      match.status !== MatchStatus.PLAYING ||
      !opponent ||
      !opponent.secretNumber ||
      !me.secretNumber
    ) {
      throw new BadRequestException("Match is not ready to play");
    }

    if (match.currentSeat !== me.seat) {
      throw new ForbiddenException("Not your turn");
    }

    if (me.moves.some((m) => m.guess === guess)) {
      throw new BadRequestException("Guess already used");
    }

    const feedback = this.gameService.calculateFeedback(
      guess,
      opponent.secretNumber,
    );
    const myAttempts = me.attemptsUsed + 1;
    const movesBefore = match.participants.reduce(
      (acc, p) => acc + p.attemptsUsed,
      0,
    );

    // Versus AI: the AI replies right away. Heavy computation happens outside
    // the transaction; the optimistic lock on updatedAt rejects stale state.
    const aiTurn =
      match.mode === GameMode.VERSUS_AI && opponent.isAi && !feedback.isWin;

    let aiPlan: {
      guess: string;
      picos: number;
      palas: number;
      isWin: boolean;
      attempts: number;
    } | null = null;

    if (aiTurn) {
      const aiGuess = this.generateAiMove(match.aiDifficulty, opponent.moves);
      const aiFeedback = this.gameService.calculateFeedback(
        aiGuess,
        me.secretNumber,
      );
      aiPlan = {
        guess: aiGuess,
        picos: aiFeedback.picos,
        palas: aiFeedback.palas,
        isWin: aiFeedback.isWin,
        attempts: opponent.attemptsUsed + 1,
      };
    }

    let winnerSeat: number | null = null;
    let finish = false;
    let endReason: EndReason = EndReason.GUESSED;

    if (feedback.isWin) {
      finish = true;
      winnerSeat = me.seat;
    } else if (aiPlan?.isWin) {
      finish = true;
      winnerSeat = opponent.seat;
    } else {
      const opponentAttempts = aiPlan ? aiPlan.attempts : opponent.attemptsUsed;
      if (myAttempts >= match.maxTurns && opponentAttempts >= match.maxTurns) {
        finish = true;
        winnerSeat = null;
        endReason = EndReason.MAX_TURNS;
      }
    }

    const nextSeat = aiPlan ? me.seat : opponent.seat;

    try {
      const { move, aiMove } = await this.prismaService.$transaction(
        async (tx) => {
          const claim = await tx.match.updateMany({
            where: {
              id: matchId,
              status: MatchStatus.PLAYING,
              currentSeat: me.seat,
              updatedAt: match.updatedAt,
            },
            data: { currentSeat: nextSeat },
          });
          if (claim.count !== 1) {
            throw new ConflictException("Match state changed, retry the move");
          }

          const createdMove = await tx.move.create({
            data: {
              matchId,
              participantId: me.id,
              turnNumber: myAttempts,
              guess,
              picos: feedback.picos,
              palas: feedback.palas,
              isWin: feedback.isWin,
            },
            select: MOVE_SELECT,
          });
          await tx.matchParticipant.update({
            where: { id: me.id },
            data: { attemptsUsed: myAttempts },
          });

          let createdAiMove: MoveRow | null = null;
          if (aiPlan) {
            createdAiMove = await tx.move.create({
              data: {
                matchId,
                participantId: opponent.id,
                turnNumber: aiPlan.attempts,
                guess: aiPlan.guess,
                picos: aiPlan.picos,
                palas: aiPlan.palas,
                isWin: aiPlan.isWin,
              },
              select: MOVE_SELECT,
            });
            await tx.matchParticipant.update({
              where: { id: opponent.id },
              data: { attemptsUsed: aiPlan.attempts },
            });
          }

          if (finish) {
            await this.finishMatch(tx, {
              matchId,
              mode: match.mode,
              isRanked: match.isRanked,
              roomId: match.roomId,
              startedAt: match.startedAt,
              winnerSeat,
              endReason,
            });
          }

          return { move: createdMove, aiMove: createdAiMove };
        },
        TX_OPTIONS,
      );

      const winner =
        winnerSeat === null
          ? null
          : match.participants.find((p) => p.seat === winnerSeat);

      return {
        move: this.toMoveView(move, match.participants),
        matchStatus: finish ? MatchStatus.FINISHED : MatchStatus.PLAYING,
        endReason: finish ? endReason : null,
        winnerId: winner?.playerId ?? null,
        currentSeat: finish ? null : nextSeat,
        nextTurn: movesBefore + (aiMove ? 2 : 1) + 1,
        aiMove: aiMove
          ? {
              guess: aiMove.guess,
              palas: aiMove.palas,
              picos: aiMove.picos,
              isWin: aiMove.isWin,
            }
          : undefined,
      };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === PRISMA_UNIQUE_VIOLATION
      ) {
        throw new ConflictException("Move already submitted for this turn");
      }
      throw error;
    }
  }

  /**
   * Finishes a match inside the caller's transaction: participant results,
   * ELO/rank (ranked human-vs-human only), match status, room and PlayerStats.
   */
  private async finishMatch(
    tx: Prisma.TransactionClient,
    params: IFinishParams,
  ): Promise<void> {
    const participants = await tx.matchParticipant.findMany({
      where: { matchId: params.matchId },
      orderBy: { seat: "asc" },
      select: {
        id: true,
        seat: true,
        playerId: true,
        isAi: true,
        attemptsUsed: true,
      },
    });

    const sums = await tx.move.groupBy({
      by: ["participantId"],
      where: { matchId: params.matchId },
      _sum: { picos: true, palas: true },
    });
    const sumByParticipant = new Map(
      sums.map((s) => [s.participantId, s._sum]),
    );

    const resultFor = (seat: number): MatchResult => {
      if (params.winnerSeat === null) return MatchResult.DRAW;
      return params.winnerSeat === seat ? MatchResult.WIN : MatchResult.LOSS;
    };

    const humans = participants.filter((p) => !p.isAi && p.playerId !== null);
    const eloBySeat = new Map<number, IEloOutcome>();

    if (params.isRanked && humans.length === 2) {
      const ratings = await this.lockPlayerRatings(
        tx,
        humans.map((h) => h.playerId as string),
      );
      const [first, second] = humans;
      const firstElo = ratings.get(first.playerId as string);
      const secondElo = ratings.get(second.playerId as string);

      if (firstElo !== undefined && secondElo !== undefined) {
        const score = (seat: number): 0 | 0.5 | 1 => {
          const r = resultFor(seat);
          return r === MatchResult.WIN ? 1 : r === MatchResult.DRAW ? 0.5 : 0;
        };
        const outcome = this.eloService.computeOutcome(
          { elo: firstElo, score: score(first.seat) },
          { elo: secondElo, score: score(second.seat) },
        );
        eloBySeat.set(first.seat, outcome.a);
        eloBySeat.set(second.seat, outcome.b);

        for (const [human, o] of [
          [first, outcome.a],
          [second, outcome.b],
        ] as const) {
          await tx.player.update({
            where: { id: human.playerId as string },
            data: { elo: o.eloAfter, rank: o.rankAfter },
          });
        }
      }
    }

    for (const p of participants) {
      const elo = eloBySeat.get(p.seat);
      await tx.matchParticipant.update({
        where: { id: p.id },
        data: {
          result: resultFor(p.seat),
          attemptsUsed: p.attemptsUsed,
          eloBefore: elo?.eloBefore,
          eloAfter: elo?.eloAfter,
          rankBefore: elo?.rankBefore,
          rankAfter: elo?.rankAfter,
        },
      });
    }

    const finishedAt = new Date();
    await tx.match.update({
      where: { id: params.matchId },
      data: {
        status: MatchStatus.FINISHED,
        endReason: params.endReason,
        currentSeat: null,
        turnDeadlineAt: null,
        finishedAt,
      },
    });

    if (params.roomId) {
      await tx.room.updateMany({
        where: { id: params.roomId },
        data: { status: "CLOSED" },
      });
    }

    const durationSec = params.startedAt
      ? Math.max(
          0,
          Math.round(
            (finishedAt.getTime() - params.startedAt.getTime()) / 1000,
          ),
        )
      : 0;

    for (const human of humans) {
      const sum = sumByParticipant.get(human.id);
      await this.statsService.recordResult(tx, {
        playerId: human.playerId as string,
        mode: params.mode,
        result: resultFor(human.seat),
        attemptsUsed: human.attemptsUsed,
        totalPicos: sum?.picos ?? 0,
        totalPalas: sum?.palas ?? 0,
        durationSec,
      });
    }
  }

  /** Row-locks both players (stable order) and returns their current ELO. */
  private async lockPlayerRatings(
    tx: Prisma.TransactionClient,
    playerIds: string[],
  ): Promise<Map<string, number>> {
    const ids = [...playerIds].sort();
    const rows = await tx.$queryRaw<Array<{ id: string; elo: number }>>`
      SELECT id::text AS id, elo
      FROM players
      WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY id
      FOR UPDATE`;
    return new Map(rows.map((r) => [r.id, r.elo]));
  }

  private async loadSummaryRow(matchId: string): Promise<MatchSummaryRow> {
    const match = await this.prismaService.match.findUnique({
      where: { id: matchId },
      select: MATCH_SUMMARY_SELECT,
    });
    if (!match) {
      throw new NotFoundException("Match not found");
    }
    return match;
  }

  private async loadSummary(matchId: string, viewerId: string) {
    const summary = await this.loadSummaryRow(matchId);
    return this.buildView(summary, viewerId);
  }

  private assertParticipant(
    summary: MatchSummaryRow,
    playerId: string,
    message: string,
  ): void {
    if (!summary.participants.some((p) => p.playerId === playerId)) {
      throw new ForbiddenException(message);
    }
  }

  /**
   * Builds the public match view. Legacy keys (player1Id, player1Number,
   * currentTurn, turnCount, winnerId) are derived from participants. Only the
   * viewer's own secret is read, via a dedicated projection.
   */
  private async buildView(summary: MatchSummaryRow, viewerId: string) {
    const me = summary.participants.find((p) => p.playerId === viewerId);
    let mySecret: string | null = null;

    if (me) {
      const own = await this.prismaService.matchParticipant.findUnique({
        where: { id: me.id },
        select: { secretNumber: true },
      });
      mySecret = own?.secretNumber ?? null;
    }

    const seat1 = summary.participants.find((p) => p.seat === 1);
    const seat2 = summary.participants.find((p) => p.seat === 2);
    const winner = summary.participants.find(
      (p) => p.result === MatchResult.WIN,
    );
    const turnCount = summary.participants.reduce(
      (acc, p) => acc + p.attemptsUsed,
      0,
    );
    const { participants, ...rest } = summary;

    return {
      ...rest,
      mySeat: me?.seat ?? null,
      player1Id: seat1?.playerId ?? null,
      player2Id: seat2?.playerId ?? null,
      player1Number: me?.seat === 1 ? mySecret : undefined,
      player2Number: me?.seat === 2 ? mySecret : undefined,
      currentTurn: turnCount + 1,
      turnCount,
      winnerId: winner?.playerId ?? null,
      participants: participants.map((p) => ({
        seat: p.seat,
        playerId: p.playerId,
        isAi: p.isAi,
        result: p.result,
        attemptsUsed: p.attemptsUsed,
      })),
    };
  }

  private toMoveView(move: MoveRow, participants: IParticipantRef[]) {
    const owner = participants.find((p) => p.id === move.participantId);
    return {
      id: move.id,
      matchId: move.matchId,
      playerId: owner?.playerId ?? null,
      seat: owner?.seat ?? null,
      isAi: owner?.isAi ?? false,
      turnNumber: move.turnNumber,
      guess: move.guess,
      palas: move.palas,
      picos: move.picos,
      isWin: move.isWin,
      createdAt: move.createdAt,
    };
  }

  /** `moves` must be the AI's OWN guesses with the feedback it received. */
  private generateAiMove(
    difficulty: Difficulty | null,
    moves: Array<{ guess: string; palas: number; picos: number }>,
  ): string {
    const usedGuesses = moves.map((m) => m.guess);

    let guess: string;
    switch (difficulty) {
      case Difficulty.MEDIUM:
        guess = this.aiService.mediumMove(moves);
        break;
      case Difficulty.HARD:
        guess = this.aiService.hardMove(moves);
        break;
      default:
        guess = this.aiService.easyMove(usedGuesses);
    }

    // Guards the (participantId, guess) unique constraint against fallbacks.
    return usedGuesses.includes(guess)
      ? this.aiService.easyMove(usedGuesses)
      : guess;
  }
}

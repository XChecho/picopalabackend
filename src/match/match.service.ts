import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import {
  Difficulty,
  EndReason,
  GameMode,
  MatchResult,
  MatchStatus,
  Prisma,
  RoomStatus,
} from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { GameService } from "../game/game.service";
import { AiService } from "../game/ai/ai.service";
import { EloService, IEloOutcome } from "../elo/elo.service";
import { StatsService } from "../stats/stats.service";
import { RoomService } from "../room/room.service";
import { CreateMatchDto } from "./dto/create-match.dto";
import { SetSecretDto } from "./dto/set-secret.dto";
import {
  MAX_MISSED_TURNS,
  SETUP_TIMEOUT_MS,
  TURN_TIMEOUT_MS,
} from "./match.constants";

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

/** Realtime notifications; the gateway turns them into socket events. */
export type MatchEvent =
  | { type: "secret_set"; matchId: string; playerId: string }
  | {
      type: "started";
      matchId: string;
      currentSeat: number;
      turnDeadlineAt: Date;
    }
  | {
      type: "move";
      matchId: string;
      playerId: string | null;
      seat: number | null;
      turnNumber: number;
      guess: string;
      picos: number;
      palas: number;
      isWin: boolean;
      auto: boolean;
      currentSeat: number | null;
      turnDeadlineAt: Date | null;
    }
  | {
      type: "finished";
      matchId: string;
      winnerId: string | null;
      endReason: EndReason | null;
      aiGuessed: boolean;
      forfeitedBy?: string;
    };

type MatchEventListener = (event: MatchEvent) => void;

@Injectable()
export class MatchService {
  private readonly logger = new Logger(MatchService.name);
  private readonly eventListeners: MatchEventListener[] = [];

  constructor(
    private readonly prismaService: PrismaService,
    private readonly gameService: GameService,
    private readonly aiService: AiService,
    private readonly eloService: EloService,
    private readonly statsService: StatsService,
    private readonly roomService: RoomService,
  ) {}

  onMatchEvent(listener: MatchEventListener): void {
    this.eventListeners.push(listener);
  }

  private emit(event: MatchEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.error(`Match event listener failed: ${String(error)}`);
      }
    }
  }

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

    // Independent reads: run them together, each DB round trip is expensive.
    const [moves, view] = await Promise.all([
      this.prismaService.move.findMany({
        where: { matchId },
        orderBy: [{ createdAt: "asc" }, { turnNumber: "asc" }],
        select: MOVE_SELECT,
      }),
      this.buildView(summary, playerId),
    ]);
    return {
      ...view,
      moves: moves.map((m) => this.toMoveView(m, summary.participants)),
    };
  }

  /**
   * Offers a rematch of a finished private duel: opens a fresh private room hosted by the
   * requester and linked to this match. The rival sees it as `rematch` in their match view
   * and accepts by joining the room with the code.
   */
  async requestRematch(playerId: string, matchId: string) {
    const summary = await this.loadSummaryRow(matchId);
    this.assertParticipant(
      summary,
      playerId,
      "Not authorized to request a rematch for this match",
    );

    if (summary.mode !== GameMode.PRIVATE || summary.roomId === null) {
      throw new BadRequestException("Only private duels support a rematch");
    }
    if (summary.status !== MatchStatus.FINISHED) {
      throw new ConflictException("The match is not finished yet");
    }

    // Two attempts: a concurrent request may take the unique slot between our read and create.
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await this.prismaService.room.findUnique({
        where: { rematchOfMatchId: matchId },
        select: {
          id: true,
          code: true,
          hostId: true,
          status: true,
          expiresAt: true,
          match: { select: { id: true } },
        },
      });

      if (existing) {
        const open =
          existing.status === RoomStatus.IN_GAME ||
          (existing.status === RoomStatus.WAITING &&
            existing.expiresAt > new Date());
        if (open) {
          if (existing.hostId === playerId) return { code: existing.code };
          throw new ConflictException("Your rival already offered a rematch");
        }
        if (existing.match) {
          throw new ConflictException("The rematch was already played");
        }
        // Abandoned offer that never became a match: detach it to free the slot.
        // Never delete the room: it may be linked to other records.
        await this.prismaService.room.updateMany({
          where: { id: existing.id, rematchOfMatchId: matchId },
          data: { rematchOfMatchId: null },
        });
      }

      try {
        const room = await this.roomService.createPrivateRoom(
          playerId,
          summary.maxTurns,
          matchId,
        );
        return { code: room.code };
      } catch (error) {
        const raced =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === PRISMA_UNIQUE_VIOLATION;
        if (!raced) throw error;
      }
    }

    throw new ConflictException("A rematch is already being set up");
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
    if (match.status === MatchStatus.WAITING) {
      await this.cancelWaitingMatch(matchId, match.roomId, playerId);
      return this.loadSummary(matchId, playerId);
    }
    if (match.status !== MatchStatus.PLAYING) {
      throw new ConflictException("Match is not in progress");
    }

    const opponent = match.participants.find((p) => p.seat !== me.seat);
    let finished = false;

    await this.prismaService.$transaction(async (tx) => {
      // Claim the match: only one finisher may win the transition.
      const claim = await tx.match.updateMany({
        where: { id: matchId, status: MatchStatus.PLAYING },
        data: { currentSeat: null },
      });
      if (claim.count !== 1) return;
      finished = true;

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

    if (finished) {
      this.emit({
        type: "finished",
        matchId,
        winnerId: opponent?.playerId ?? null,
        endReason: reason,
        aiGuessed: false,
        forfeitedBy: playerId,
      });
    }

    return this.loadSummary(matchId, playerId);
  }

  /** A player left before the match started: nobody wins, no stats. */
  private async cancelWaitingMatch(
    matchId: string,
    roomId: string | null,
    playerId: string,
  ): Promise<void> {
    const cancelled = await this.prismaService.$transaction(async (tx) => {
      const claim = await tx.match.updateMany({
        where: { id: matchId, status: MatchStatus.WAITING },
        data: {
          status: MatchStatus.CANCELLED,
          endReason: EndReason.ABANDONED,
          currentSeat: null,
          turnDeadlineAt: null,
          finishedAt: new Date(),
        },
      });
      if (claim.count !== 1) return false;
      if (roomId) {
        await tx.room.updateMany({
          where: { id: roomId },
          data: { status: "CLOSED" },
        });
      }
      return true;
    }, TX_OPTIONS);

    if (cancelled) {
      this.emit({
        type: "finished",
        matchId,
        winnerId: null,
        endReason: EndReason.ABANDONED,
        aiGuessed: false,
        forfeitedBy: playerId,
      });
    }
  }

  async getActiveMatchByPlayer(playerId: string) {
    const match = await this.prismaService.match.findFirst({
      where: {
        // WAITING = human match still collecting secrets.
        status: { in: [MatchStatus.WAITING, MatchStatus.PLAYING] },
        participants: { some: { playerId } },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });

    return match ? this.loadSummary(match.id, playerId) : null;
  }

  /**
   * `options.auto` marks a move played by the server on behalf of a player
   * whose turn clock expired: it skips the deadline check and counts as a
   * missed turn instead of resetting the counter.
   */
  async submitMove(
    playerId: string,
    matchId: string,
    guess: string,
    options: { auto?: boolean; expectedDeadlineAt?: Date | null } = {},
  ) {
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
        turnDeadlineAt: true,
        participants: {
          orderBy: { seat: "asc" },
          select: {
            id: true,
            seat: true,
            playerId: true,
            isAi: true,
            secretNumber: true,
            attemptsUsed: true,
            missedTurns: true,
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

    // The scheduler decided on a specific expired turn; if the turn moved on
    // in the meantime this auto move is stale.
    if (
      options.auto &&
      options.expectedDeadlineAt !== undefined &&
      match.turnDeadlineAt?.getTime() !== options.expectedDeadlineAt?.getTime()
    ) {
      throw new ConflictException("Turn already advanced");
    }

    if (
      !options.auto &&
      match.turnDeadlineAt &&
      match.turnDeadlineAt.getTime() < Date.now()
    ) {
      throw new ConflictException("Turn time expired");
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
    // Only human-vs-human matches run a turn clock.
    const nextDeadline =
      finish || match.mode === GameMode.VERSUS_AI
        ? null
        : new Date(Date.now() + TURN_TIMEOUT_MS);

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
            data: { currentSeat: nextSeat, turnDeadlineAt: nextDeadline },
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
            data: {
              attemptsUsed: myAttempts,
              missedTurns: options.auto ? me.missedTurns + 1 : 0,
            },
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

      this.emit({
        type: "move",
        matchId,
        playerId: me.playerId,
        seat: me.seat,
        turnNumber: move.turnNumber,
        guess: move.guess,
        picos: move.picos,
        palas: move.palas,
        isWin: move.isWin,
        auto: options.auto === true,
        currentSeat: finish ? null : nextSeat,
        turnDeadlineAt: nextDeadline,
      });
      if (finish) {
        this.emit({
          type: "finished",
          matchId,
          winnerId: winner?.playerId ?? null,
          endReason,
          aiGuessed: aiMove?.isWin === true,
        });
      }

      return {
        move: this.toMoveView(move, match.participants),
        matchStatus: finish ? MatchStatus.FINISHED : MatchStatus.PLAYING,
        endReason: finish ? endReason : null,
        winnerId: winner?.playerId ?? null,
        currentSeat: finish ? null : nextSeat,
        turnDeadlineAt: nextDeadline,
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
   * Stores the caller's secret (chosen or random) while the match is WAITING.
   * Starts the match as soon as both seats have one.
   */
  async setSecret(playerId: string, matchId: string, dto: SetSecretDto) {
    if (dto.random === true && dto.secret !== undefined) {
      throw new BadRequestException("Send either secret or random, not both");
    }

    let secret: string;
    if (dto.random === true) {
      secret = this.gameService.generateSecretNumber();
    } else {
      if (dto.secret === undefined) {
        throw new BadRequestException("secret or random is required");
      }
      const validation = this.gameService.validateGuess(dto.secret);
      if (!validation.valid) {
        throw new BadRequestException(validation.error);
      }
      secret = dto.secret;
    }

    const match = await this.prismaService.match.findUnique({
      where: { id: matchId },
      select: {
        id: true,
        status: true,
        participants: { select: { id: true, playerId: true } },
      },
    });
    if (!match) {
      throw new NotFoundException("Match not found");
    }
    const me = match.participants.find((p) => p.playerId === playerId);
    if (!me) {
      throw new ForbiddenException("Not authorized to play in this match");
    }
    if (match.status !== MatchStatus.WAITING) {
      throw new ConflictException("Secrets can no longer be set");
    }

    const claim = await this.prismaService.matchParticipant.updateMany({
      where: { id: me.id, secretNumber: null },
      data: { secretNumber: secret },
    });
    if (claim.count !== 1) {
      throw new ConflictException("Secret already set");
    }

    this.emit({ type: "secret_set", matchId, playerId });
    const started = await this.startIfReady(matchId);
    const view = await this.loadSummary(matchId, playerId);
    return { ...view, started };
  }

  /** Match ids in `status` whose server clock already expired. */
  async findDueMatchIds(
    status: "WAITING" | "PLAYING",
    now: Date = new Date(),
  ): Promise<string[]> {
    const rows = await this.prismaService.match.findMany({
      where: {
        status,
        mode: { not: GameMode.VERSUS_AI },
        turnDeadlineAt: { lte: now },
      },
      select: { id: true },
      orderBy: { turnDeadlineAt: "asc" },
      take: 100,
    });
    return rows.map((r) => r.id);
  }

  /**
   * Secret-selection deadline reached: seats without a secret get a random
   * one and the match starts. Returns whether this call started it.
   */
  async completeSetup(matchId: string): Promise<boolean> {
    const match = await this.prismaService.match.findUnique({
      where: { id: matchId },
      select: {
        status: true,
        turnDeadlineAt: true,
        participants: { select: { id: true, secretNumber: true } },
      },
    });
    if (
      !match ||
      match.status !== MatchStatus.WAITING ||
      !match.turnDeadlineAt ||
      match.turnDeadlineAt.getTime() > Date.now()
    ) {
      return false;
    }

    for (const participant of match.participants) {
      if (participant.secretNumber) continue;
      await this.prismaService.matchParticipant.updateMany({
        where: { id: participant.id, secretNumber: null },
        data: { secretNumber: this.gameService.generateSecretNumber() },
      });
    }
    return this.startMatch(matchId);
  }

  /**
   * Turn clock expired: the server plays a random unused guess (same as the
   * EASY AI, so nobody gains an edge). After MAX_MISSED_TURNS in a row the
   * absent player loses by TIMEOUT instead.
   */
  async autoPlayTurn(matchId: string): Promise<boolean> {
    const match = await this.prismaService.match.findUnique({
      where: { id: matchId },
      select: {
        status: true,
        mode: true,
        currentSeat: true,
        turnDeadlineAt: true,
        participants: {
          select: {
            seat: true,
            playerId: true,
            missedTurns: true,
            moves: { select: { guess: true } },
          },
        },
      },
    });
    if (
      !match ||
      match.status !== MatchStatus.PLAYING ||
      match.mode === GameMode.VERSUS_AI ||
      !match.turnDeadlineAt ||
      match.turnDeadlineAt.getTime() > Date.now()
    ) {
      return false;
    }

    const current = match.participants.find(
      (p) => p.seat === match.currentSeat,
    );
    if (!current?.playerId) return false;

    if (current.missedTurns + 1 >= MAX_MISSED_TURNS) {
      await this.forfeitMatch(current.playerId, matchId, EndReason.TIMEOUT);
      return true;
    }

    const guess = this.aiService.easyMove(current.moves.map((m) => m.guess));
    await this.submitMove(current.playerId, matchId, guess, {
      auto: true,
      expectedDeadlineAt: match.turnDeadlineAt,
    });
    return true;
  }

  async markDisconnected(playerId: string, matchId: string): Promise<void> {
    await this.prismaService.matchParticipant.updateMany({
      where: {
        matchId,
        playerId,
        match: {
          status: MatchStatus.PLAYING,
          mode: { not: GameMode.VERSUS_AI },
        },
      },
      data: { disconnectedAt: new Date() },
    });
  }

  /** Returns true when the player was flagged as disconnected before. */
  async markConnected(playerId: string, matchId: string): Promise<boolean> {
    const result = await this.prismaService.matchParticipant.updateMany({
      where: { matchId, playerId, disconnectedAt: { not: null } },
      data: { disconnectedAt: null },
    });
    return result.count > 0;
  }

  /** Players of live matches whose grace period without a socket is over. */
  async findAbandonedPlayers(
    graceMs: number,
    now: Date = new Date(),
  ): Promise<Array<{ matchId: string; playerId: string }>> {
    const rows = await this.prismaService.matchParticipant.findMany({
      where: {
        disconnectedAt: { lte: new Date(now.getTime() - graceMs) },
        playerId: { not: null },
        match: { status: MatchStatus.PLAYING },
      },
      select: { matchId: true, playerId: true },
      orderBy: { disconnectedAt: "asc" },
      take: 100,
    });
    return rows.flatMap((r) =>
      r.playerId ? [{ matchId: r.matchId, playerId: r.playerId }] : [],
    );
  }

  /**
   * Resolves players who were disconnected past the grace period. If the
   * rival is gone too, nobody is to blame: the match ends as a draw instead
   * of punishing an arbitrary side.
   */
  async resolveAbandoned(matchId: string, playerId: string): Promise<void> {
    const match = await this.prismaService.match.findUnique({
      where: { id: matchId },
      select: {
        status: true,
        mode: true,
        isRanked: true,
        roomId: true,
        startedAt: true,
        participants: {
          select: { playerId: true, disconnectedAt: true },
        },
      },
    });
    if (!match || match.status !== MatchStatus.PLAYING) return;

    const bothGone = match.participants.every(
      (p) => p.playerId === null || p.disconnectedAt !== null,
    );
    if (!bothGone) {
      await this.forfeitMatch(playerId, matchId);
      return;
    }

    let finished = false;
    await this.prismaService.$transaction(async (tx) => {
      const claim = await tx.match.updateMany({
        where: { id: matchId, status: MatchStatus.PLAYING },
        data: { currentSeat: null },
      });
      if (claim.count !== 1) return;
      finished = true;
      await this.finishMatch(tx, {
        matchId,
        mode: match.mode,
        isRanked: false, // no rating change when nobody is at fault
        roomId: match.roomId,
        startedAt: match.startedAt,
        winnerSeat: null,
        endReason: EndReason.ABANDONED,
      });
    }, TX_OPTIONS);

    if (finished) {
      this.emit({
        type: "finished",
        matchId,
        winnerId: null,
        endReason: EndReason.ABANDONED,
        aiGuessed: false,
      });
    }
  }

  /**
   * After a restart nobody has a socket yet. Give every live human match a
   * fresh grace period and turn clock so downtime never costs a player.
   */
  async resetClocksAfterRestart(): Promise<void> {
    const now = new Date();
    await this.prismaService.matchParticipant.updateMany({
      where: {
        match: {
          status: MatchStatus.PLAYING,
          mode: { not: GameMode.VERSUS_AI },
        },
      },
      data: { disconnectedAt: now },
    });
    await this.prismaService.match.updateMany({
      where: {
        status: MatchStatus.PLAYING,
        mode: { not: GameMode.VERSUS_AI },
        turnDeadlineAt: { lte: now },
      },
      data: { turnDeadlineAt: new Date(now.getTime() + TURN_TIMEOUT_MS) },
    });
    await this.prismaService.match.updateMany({
      where: {
        status: MatchStatus.WAITING,
        turnDeadlineAt: { lte: now },
      },
      data: { turnDeadlineAt: new Date(now.getTime() + SETUP_TIMEOUT_MS) },
    });
  }

  private async startIfReady(matchId: string): Promise<boolean> {
    const pending = await this.prismaService.matchParticipant.count({
      where: { matchId, secretNumber: null },
    });
    return pending === 0 ? this.startMatch(matchId) : false;
  }

  /** WAITING -> PLAYING; only one concurrent caller wins the transition. */
  private async startMatch(matchId: string): Promise<boolean> {
    const match = await this.prismaService.match.findUnique({
      where: { id: matchId },
      select: { startingSeat: true },
    });
    if (!match) return false;

    const now = new Date();
    const currentSeat = match.startingSeat ?? 1;
    const turnDeadlineAt = new Date(now.getTime() + TURN_TIMEOUT_MS);
    const claim = await this.prismaService.match.updateMany({
      where: { id: matchId, status: MatchStatus.WAITING },
      data: {
        status: MatchStatus.PLAYING,
        startedAt: now,
        currentSeat,
        turnDeadlineAt,
      },
    });
    if (claim.count !== 1) return false;

    this.emit({ type: "started", matchId, currentSeat, turnDeadlineAt });
    return true;
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
    // Once the match is over both secrets are public to its participants.
    const revealBoth =
      me !== undefined && summary.status === MatchStatus.FINISHED;
    let mySecret: string | null = null;
    let rivalSecret: string | null = null;

    if (revealBoth) {
      const rows = await this.prismaService.matchParticipant.findMany({
        where: { matchId: summary.id },
        select: { id: true, secretNumber: true },
      });
      mySecret = rows.find((row) => row.id === me.id)?.secretNumber ?? null;
      rivalSecret = rows.find((row) => row.id !== me.id)?.secretNumber ?? null;
    } else if (me) {
      const own = await this.prismaService.matchParticipant.findUnique({
        where: { id: me.id },
        select: { secretNumber: true },
      });
      mySecret = own?.secretNumber ?? null;
    }

    const rematch = await this.findRematchOffer(summary);

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
      player1Number: this.secretForSeat(1, me?.seat, mySecret, rivalSecret),
      player2Number: this.secretForSeat(2, me?.seat, mySecret, rivalSecret),
      rematch,
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

  /** The viewer's own secret, or the rival's once the match is over; undefined while it must stay hidden. */
  private secretForSeat(
    seat: number,
    mySeat: number | undefined,
    mySecret: string | null,
    rivalSecret: string | null,
  ): string | null | undefined {
    if (mySeat === undefined) return undefined;
    if (mySeat === seat) return mySecret;
    return rivalSecret ?? undefined;
  }

  /** Pending (or just accepted) rematch offer of a finished private duel. */
  private async findRematchOffer(summary: MatchSummaryRow) {
    if (
      summary.mode !== GameMode.PRIVATE ||
      summary.status !== MatchStatus.FINISHED
    ) {
      return null;
    }
    const room = await this.prismaService.room.findUnique({
      where: { rematchOfMatchId: summary.id },
      select: { code: true, hostId: true, status: true, expiresAt: true },
    });
    if (!room) return null;
    const open =
      room.status === RoomStatus.IN_GAME ||
      (room.status === RoomStatus.WAITING && room.expiresAt > new Date());
    return open ? { code: room.code, requestedBy: room.hostId } : null;
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

import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { GameMode, MatchStatus, Prisma, RoomStatus } from "@prisma/client";
import { randomInt } from "crypto";
import Redis from "ioredis";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { GameService } from "../game/game.service";
import { SETUP_TIMEOUT_MS, TURN_TIMEOUT_MS } from "../match/match.constants";

const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const ROOM_CODE_ATTEMPTS = 5;
const ROOM_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_TURNS = 12;
const PRISMA_UNIQUE_VIOLATION = "P2002";

const QUEUE_KEY = "mm:global:queue";
const TICKET_KEY_PREFIX = "mm:global:ticket:";
const TICKET_TTL_SEC = 300;
const QUEUE_SCAN_SIZE = 50;
const BASE_ELO_RANGE = 200;
const ELO_RANGE_STEP = 50;
const ELO_RANGE_STEP_SEC = 10;
const MAX_ELO_RANGE = 1000;
const ESTIMATED_WAIT_SEC = 30;

interface IQueueTicket {
  elo: number;
  maxTurns: number;
  joinedAt: number;
}

export interface IMatchFoundEvent {
  matchId: string;
  roomId: string | null;
  players: Array<{ id: string; username: string }>;
}

export type MatchFoundListener = (event: IMatchFoundEvent) => void;

interface IHumanMatchParams {
  mode: GameMode;
  isRanked: boolean;
  maxTurns: number;
  roomId: string | null;
  seat1PlayerId: string;
  seat2PlayerId: string;
  /** true: players pick their own secret first (match starts WAITING). */
  awaitSecrets: boolean;
}

@Injectable()
export class RoomService {
  private readonly logger = new Logger(RoomService.name);
  private readonly matchFoundListeners: MatchFoundListener[] = [];

  constructor(
    private readonly prismaService: PrismaService,
    private readonly gameService: GameService,
    private readonly redisService: RedisService,
  ) {}

  /** Lets the gateway push `match_found` to both players, whichever path matched them. */
  onMatchFound(listener: MatchFoundListener): void {
    this.matchFoundListeners.push(listener);
  }

  async createPrivateRoom(hostId: string, maxTurns?: number) {
    const expiresAt = new Date(Date.now() + ROOM_TTL_MS);

    for (let attempt = 0; attempt < ROOM_CODE_ATTEMPTS; attempt++) {
      try {
        const room = await this.prismaService.room.create({
          data: {
            code: this.generateRoomCode(),
            hostId,
            maxTurns,
            status: RoomStatus.WAITING,
            expiresAt,
          },
          select: {
            id: true,
            code: true,
            hostId: true,
            maxTurns: true,
            status: true,
            expiresAt: true,
            createdAt: true,
          },
        });
        return { ...room, type: "PRIVATE" as const };
      } catch (error) {
        if (!this.isUniqueViolation(error)) throw error;
      }
    }

    throw new ConflictException("Could not allocate a room code, try again");
  }

  async joinPrivateRoom(guestId: string, code: string) {
    const room = await this.prismaService.room.findUnique({
      where: { code: code.trim().toUpperCase() },
      select: {
        id: true,
        code: true,
        hostId: true,
        status: true,
        maxTurns: true,
        expiresAt: true,
      },
    });

    if (!room) {
      throw new NotFoundException("Room not found");
    }

    if (room.status === RoomStatus.WAITING && room.expiresAt <= new Date()) {
      await this.prismaService.room.updateMany({
        where: { id: room.id, status: RoomStatus.WAITING },
        data: { status: RoomStatus.EXPIRED },
      });
      throw new ConflictException("Room has expired");
    }

    if (
      room.status === RoomStatus.EXPIRED ||
      room.status === RoomStatus.CLOSED
    ) {
      throw new ConflictException("Room has expired");
    }

    if (room.status === RoomStatus.IN_GAME) {
      throw new ConflictException("Room is already full");
    }

    if (room.hostId === guestId) {
      throw new BadRequestException("Cannot join your own room");
    }

    const match = await this.prismaService.$transaction(async (tx) => {
      const claim = await tx.room.updateMany({
        where: {
          id: room.id,
          status: RoomStatus.WAITING,
          expiresAt: { gt: new Date() },
        },
        data: { status: RoomStatus.IN_GAME },
      });
      if (claim.count !== 1) {
        throw new ConflictException("Room is already full");
      }

      return this.createHumanMatch(tx, {
        mode: GameMode.PRIVATE,
        isRanked: false,
        maxTurns: room.maxTurns,
        roomId: room.id,
        seat1PlayerId: room.hostId,
        seat2PlayerId: guestId,
        awaitSecrets: true,
      });
    });

    await this.emitMatchFound(match.id, room.id, [room.hostId, guestId]);

    return {
      room: {
        id: room.id,
        code: room.code,
        hostId: room.hostId,
        guestId,
        status: RoomStatus.IN_GAME,
        matchId: match.id,
      },
      match: this.toMatchView(match, room.hostId, guestId),
    };
  }

  /** Room state for the host or the guest; anyone else gets a 404. */
  async getRoom(playerId: string, code: string) {
    const room = await this.prismaService.room.findUnique({
      where: { code: code.trim().toUpperCase() },
      select: {
        id: true,
        code: true,
        hostId: true,
        status: true,
        maxTurns: true,
        expiresAt: true,
        match: {
          select: {
            id: true,
            status: true,
            participants: { select: { seat: true, playerId: true } },
          },
        },
      },
    });

    const guestId =
      room?.match?.participants.find((p) => p.playerId !== room.hostId)
        ?.playerId ?? null;
    if (!room || (room.hostId !== playerId && guestId !== playerId)) {
      throw new NotFoundException("Room not found");
    }

    return {
      id: room.id,
      code: room.code,
      hostId: room.hostId,
      guestId,
      status: room.status,
      maxTurns: room.maxTurns,
      expiresAt: room.expiresAt,
      matchId: room.match?.id ?? null,
      matchStatus: room.match?.status ?? null,
    };
  }

  /** Host closes a room nobody has joined yet. */
  async cancelPrivateRoom(hostId: string, code: string) {
    const room = await this.prismaService.room.findUnique({
      where: { code: code.trim().toUpperCase() },
      select: { id: true, hostId: true },
    });
    if (!room || room.hostId !== hostId) {
      throw new NotFoundException("Room not found");
    }

    const claim = await this.prismaService.room.updateMany({
      where: { id: room.id, status: RoomStatus.WAITING },
      data: { status: RoomStatus.CLOSED },
    });
    if (claim.count !== 1) {
      throw new ConflictException("Room can no longer be cancelled");
    }
    return { message: "Room closed" };
  }

  async joinGlobalQueue(
    playerId: string,
    maxTurns: number = DEFAULT_MAX_TURNS,
  ) {
    const redis = this.requireRedis();

    const player = await this.prismaService.player.findFirst({
      where: { id: playerId, deletedAt: null },
      select: { elo: true },
    });
    if (!player) {
      throw new NotFoundException("Player not found");
    }

    try {
      // Take ourselves out first so we can never claim our own ticket, but
      // remember the original score to keep our place when re-joining.
      const previousScore = await redis.zscore(QUEUE_KEY, playerId);
      await redis.zrem(QUEUE_KEY, playerId);

      const opponent = await this.claimOpponent(
        redis,
        playerId,
        player.elo,
        maxTurns,
      );

      if (opponent) {
        return await this.createGlobalMatch(
          redis,
          opponent,
          playerId,
          maxTurns,
        );
      }

      const joinedAt = previousScore ? Number(previousScore) : Date.now();
      const ticket: IQueueTicket = { elo: player.elo, maxTurns, joinedAt };
      await redis.set(
        TICKET_KEY_PREFIX + playerId,
        JSON.stringify(ticket),
        "EX",
        TICKET_TTL_SEC,
      );
      await redis.zadd(QUEUE_KEY, joinedAt, playerId);
      const rank = await redis.zrank(QUEUE_KEY, playerId);

      return {
        status: "queued" as const,
        queuePosition: (rank ?? 0) + 1,
        estimatedWait: ESTIMATED_WAIT_SEC,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error(`Matchmaking failure: ${(error as Error).message}`);
      throw new ServiceUnavailableException("Matchmaking is unavailable");
    }
  }

  async leaveGlobalQueue(playerId: string) {
    const redis = this.requireRedis();
    try {
      await redis.zrem(QUEUE_KEY, playerId);
      await redis.del(TICKET_KEY_PREFIX + playerId);
    } catch (error) {
      this.logger.error(`Leave queue failure: ${(error as Error).message}`);
      throw new ServiceUnavailableException("Matchmaking is unavailable");
    }

    return { message: "Left matchmaking queue" };
  }

  /**
   * Scans the oldest tickets and atomically claims a compatible one.
   * ZREM returning 1 guarantees a single claimer per ticket.
   */
  private async claimOpponent(
    redis: Redis,
    playerId: string,
    elo: number,
    maxTurns: number,
  ): Promise<{ id: string; ticket: IQueueTicket } | null> {
    const candidates = await redis.zrange(QUEUE_KEY, 0, QUEUE_SCAN_SIZE - 1);
    const now = Date.now();

    for (const candidateId of candidates) {
      if (candidateId === playerId) continue;

      const raw = await redis.get(TICKET_KEY_PREFIX + candidateId);
      if (!raw) {
        await redis.zrem(QUEUE_KEY, candidateId);
        continue;
      }

      const ticket = this.parseTicket(raw);
      if (!ticket) {
        await redis.zrem(QUEUE_KEY, candidateId);
        continue;
      }

      const waitedSteps = Math.floor(
        (now - ticket.joinedAt) / 1000 / ELO_RANGE_STEP_SEC,
      );
      const range = Math.min(
        MAX_ELO_RANGE,
        BASE_ELO_RANGE + waitedSteps * ELO_RANGE_STEP,
      );

      if (ticket.maxTurns !== maxTurns || Math.abs(ticket.elo - elo) > range) {
        continue;
      }

      const removed = await redis.zrem(QUEUE_KEY, candidateId);
      if (removed !== 1) continue; // someone else claimed it

      await redis.del(TICKET_KEY_PREFIX + candidateId);
      return { id: candidateId, ticket };
    }

    return null;
  }

  private async createGlobalMatch(
    redis: Redis,
    opponent: { id: string; ticket: IQueueTicket },
    playerId: string,
    maxTurns: number,
  ) {
    const selfFirst = randomInt(0, 2) === 0;
    const seat1 = selfFirst ? playerId : opponent.id;
    const seat2 = selfFirst ? opponent.id : playerId;

    try {
      const match = await this.prismaService.$transaction((tx) =>
        this.createHumanMatch(tx, {
          mode: GameMode.GLOBAL,
          isRanked: true,
          maxTurns,
          roomId: null,
          seat1PlayerId: seat1,
          seat2PlayerId: seat2,
          awaitSecrets: false,
        }),
      );

      await this.emitMatchFound(match.id, null, [seat1, seat2]);

      return {
        status: "matched" as const,
        room: null,
        match: this.toMatchView(match, seat1, seat2),
      };
    } catch (error) {
      // Put the waiting opponent back so a transient failure doesn't drop them.
      await redis.set(
        TICKET_KEY_PREFIX + opponent.id,
        JSON.stringify(opponent.ticket),
        "EX",
        TICKET_TTL_SEC,
      );
      await redis.zadd(QUEUE_KEY, opponent.ticket.joinedAt, opponent.id);
      throw error;
    }
  }

  private async createHumanMatch(
    tx: Prisma.TransactionClient,
    params: IHumanMatchParams,
  ) {
    const startingSeat = randomInt(1, 3);
    const now = Date.now();
    // Secrets are chosen by the players (WAITING) or assigned here (PLAYING);
    // either way they are written but deliberately not selected back.
    const secretFor = (): string | undefined =>
      params.awaitSecrets ? undefined : this.gameService.generateSecretNumber();

    return tx.match.create({
      data: {
        mode: params.mode,
        status: params.awaitSecrets ? MatchStatus.WAITING : MatchStatus.PLAYING,
        isRanked: params.isRanked,
        maxTurns: params.maxTurns,
        startingSeat,
        currentSeat: params.awaitSecrets ? null : startingSeat,
        // Server clock: secret selection while WAITING, turn clock while PLAYING.
        turnDeadlineAt: new Date(
          now + (params.awaitSecrets ? SETUP_TIMEOUT_MS : TURN_TIMEOUT_MS),
        ),
        roomId: params.roomId,
        startedAt: params.awaitSecrets ? null : new Date(now),
        participants: {
          create: [
            {
              seat: 1,
              playerId: params.seat1PlayerId,
              secretNumber: secretFor(),
            },
            {
              seat: 2,
              playerId: params.seat2PlayerId,
              secretNumber: secretFor(),
            },
          ],
        },
      },
      select: {
        id: true,
        mode: true,
        status: true,
        maxTurns: true,
        startingSeat: true,
        currentSeat: true,
        turnDeadlineAt: true,
      },
    });
  }

  private toMatchView(
    match: {
      id: string;
      mode: GameMode;
      status: MatchStatus;
      maxTurns: number;
      startingSeat: number | null;
      currentSeat: number | null;
      turnDeadlineAt: Date | null;
    },
    player1Id: string,
    player2Id: string,
  ) {
    return {
      id: match.id,
      mode: match.mode,
      status: match.status,
      player1Id,
      player2Id,
      currentTurn: 1,
      currentSeat: match.currentSeat,
      turnDeadlineAt: match.turnDeadlineAt,
      startingSeat: match.startingSeat,
      maxTurns: match.maxTurns,
    };
  }

  private async emitMatchFound(
    matchId: string,
    roomId: string | null,
    playerIds: string[],
  ): Promise<void> {
    if (this.matchFoundListeners.length === 0) return;

    try {
      const players = await this.prismaService.player.findMany({
        where: { id: { in: playerIds } },
        select: { id: true, username: true },
      });
      const event: IMatchFoundEvent = { matchId, roomId, players };
      this.matchFoundListeners.forEach((listener) => listener(event));
    } catch (error) {
      // Notification is best-effort; the match itself is already persisted.
      this.logger.warn(
        `match_found notification failed: ${(error as Error).message}`,
      );
    }
  }

  private requireRedis(): Redis {
    const client = this.redisService.getClient();
    if (!client) {
      throw new ServiceUnavailableException("Matchmaking is unavailable");
    }
    return client;
  }

  private parseTicket(raw: string): IQueueTicket | null {
    try {
      const value: unknown = JSON.parse(raw);
      if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as IQueueTicket).elo === "number" &&
        typeof (value as IQueueTicket).maxTurns === "number" &&
        typeof (value as IQueueTicket).joinedAt === "number"
      ) {
        return value as IQueueTicket;
      }
      return null;
    } catch {
      return null;
    }
  }

  private generateRoomCode(): string {
    let code = "";
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_CHARS.charAt(randomInt(0, ROOM_CODE_CHARS.length));
    }
    return code;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === PRISMA_UNIQUE_VIOLATION
    );
  }
}

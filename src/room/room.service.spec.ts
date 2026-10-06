import {
  BadRequestException,
  ConflictException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { MatchStatus, Prisma, RoomStatus } from "@prisma/client";
import { GameService } from "../game/game.service";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { IMatchFoundEvent, RoomService } from "./room.service";

const NOW = new Date("2025-03-01T12:00:00.000Z");
const QUEUE_KEY = "mm:global:queue";
const TICKET = "mm:global:ticket:";

interface IRedisMock {
  zscore: jest.Mock;
  zrem: jest.Mock;
  zrange: jest.Mock;
  zadd: jest.Mock;
  zrank: jest.Mock;
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
}

interface ITxMock {
  room: { updateMany: jest.Mock };
  match: { create: jest.Mock };
}

const uniqueError = (): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError("dup", {
    code: "P2002",
    clientVersion: "test",
  });

describe("RoomService", () => {
  let service: RoomService;
  let prisma: {
    room: { create: jest.Mock; findUnique: jest.Mock; updateMany: jest.Mock };
    player: { findFirst: jest.Mock; findMany: jest.Mock };
    $transaction: jest.Mock;
  };
  let tx: ITxMock;
  let redis: IRedisMock;
  let redisService: { getClient: jest.Mock };

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);

    tx = {
      room: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      match: {
        create: jest.fn().mockResolvedValue({
          id: "match-1",
          mode: "PRIVATE",
          status: MatchStatus.PLAYING,
          maxTurns: 12,
          startingSeat: 1,
          currentSeat: 1,
        }),
      },
    };
    prisma = {
      room: {
        create: jest.fn(),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      player: {
        findFirst: jest.fn().mockResolvedValue({ elo: 1000 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn((fn: (t: Prisma.TransactionClient) => unknown) =>
        fn(tx as unknown as Prisma.TransactionClient),
      ),
    };
    redis = {
      zscore: jest.fn().mockResolvedValue(null),
      zrem: jest.fn().mockResolvedValue(1),
      zrange: jest.fn().mockResolvedValue([]),
      zadd: jest.fn().mockResolvedValue(1),
      zrank: jest.fn().mockResolvedValue(0),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue("OK"),
      del: jest.fn().mockResolvedValue(1),
    };
    redisService = { getClient: jest.fn().mockReturnValue(redis) };

    service = new RoomService(
      prisma as unknown as PrismaService,
      new GameService(),
      redisService as unknown as RedisService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("createPrivateRoom", () => {
    it("creates a WAITING room with a 6-char alphanumeric code expiring in 1 hour", async () => {
      prisma.room.create.mockImplementation(
        async ({ data }: { data: Record<string, unknown> }) => ({
          id: "room-1",
          createdAt: NOW,
          ...data,
        }),
      );

      const room = await service.createPrivateRoom("host", 8);

      const data = prisma.room.create.mock.calls[0][0].data;
      expect(data.code).toMatch(/^[A-Z0-9]{6}$/);
      expect(data).toMatchObject({
        hostId: "host",
        maxTurns: 8,
        status: RoomStatus.WAITING,
      });
      expect(data.expiresAt).toEqual(new Date(NOW.getTime() + 3_600_000));
      expect(room.type).toBe("PRIVATE");
    });

    it("retries on code collisions and succeeds", async () => {
      prisma.room.create
        .mockRejectedValueOnce(uniqueError())
        .mockRejectedValueOnce(uniqueError())
        .mockResolvedValueOnce({ id: "room-1", code: "ABC123" });

      const room = await service.createPrivateRoom("host");

      expect(prisma.room.create).toHaveBeenCalledTimes(3);
      expect(room.id).toBe("room-1");
    });

    it("gives up with 409 after 5 collisions", async () => {
      prisma.room.create.mockRejectedValue(uniqueError());

      await expect(service.createPrivateRoom("host")).rejects.toThrow(
        ConflictException,
      );
      expect(prisma.room.create).toHaveBeenCalledTimes(5);
    });

    it("rethrows non-unique errors immediately", async () => {
      const boom = new Error("db down");
      prisma.room.create.mockRejectedValue(boom);

      await expect(service.createPrivateRoom("host")).rejects.toBe(boom);
      expect(prisma.room.create).toHaveBeenCalledTimes(1);
    });
  });

  describe("joinPrivateRoom", () => {
    const waitingRoom = (overrides: Record<string, unknown> = {}) => ({
      id: "room-1",
      code: "ABC123",
      hostId: "host",
      status: RoomStatus.WAITING,
      maxTurns: 12,
      expiresAt: new Date(NOW.getTime() + 60_000),
      ...overrides,
    });

    it("normalises the code, claims the room and creates the match", async () => {
      prisma.room.findUnique.mockResolvedValue(waitingRoom());

      const result = await service.joinPrivateRoom("guest", "  abc123 ");

      expect(prisma.room.findUnique.mock.calls[0][0].where).toEqual({
        code: "ABC123",
      });
      expect(tx.room.updateMany).toHaveBeenCalledWith({
        where: {
          id: "room-1",
          status: RoomStatus.WAITING,
          expiresAt: { gt: NOW },
        },
        data: { status: RoomStatus.IN_GAME },
      });
      const created = tx.match.create.mock.calls[0][0];
      expect(created.data.isRanked).toBe(false);
      expect(created.data.participants.create).toEqual([
        expect.objectContaining({ seat: 1, playerId: "host" }),
        expect.objectContaining({ seat: 2, playerId: "guest" }),
      ]);
      expect(result.room).toEqual({
        id: "room-1",
        code: "ABC123",
        hostId: "host",
        guestId: "guest",
        status: RoomStatus.IN_GAME,
        matchId: "match-1",
      });
      expect(result.match.player1Id).toBe("host");
      expect(result.match.player2Id).toBe("guest");
    });

    it("never selects or returns secret numbers", async () => {
      prisma.room.findUnique.mockResolvedValue(waitingRoom());

      const result = await service.joinPrivateRoom("guest", "ABC123");

      expect(tx.match.create.mock.calls[0][0].select).not.toHaveProperty(
        "participants",
      );
      expect(JSON.stringify(result)).not.toContain("secretNumber");
    });

    it("throws 404 for an unknown code", async () => {
      prisma.room.findUnique.mockResolvedValue(null);
      await expect(service.joinPrivateRoom("guest", "ZZZZZZ")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("marks a WAITING room past its expiry as EXPIRED and answers 409", async () => {
      prisma.room.findUnique.mockResolvedValue(
        waitingRoom({ expiresAt: new Date(NOW.getTime() - 1) }),
      );

      await expect(service.joinPrivateRoom("guest", "ABC123")).rejects.toThrow(
        "Room has expired",
      );
      expect(prisma.room.updateMany).toHaveBeenCalledWith({
        where: { id: "room-1", status: RoomStatus.WAITING },
        data: { status: RoomStatus.EXPIRED },
      });
    });

    it.each([RoomStatus.EXPIRED, RoomStatus.CLOSED])(
      "rejects %s rooms as expired",
      async (status) => {
        prisma.room.findUnique.mockResolvedValue(waitingRoom({ status }));
        await expect(
          service.joinPrivateRoom("guest", "ABC123"),
        ).rejects.toThrow("Room has expired");
      },
    );

    it("rejects IN_GAME rooms as full", async () => {
      prisma.room.findUnique.mockResolvedValue(
        waitingRoom({ status: RoomStatus.IN_GAME }),
      );
      await expect(service.joinPrivateRoom("guest", "ABC123")).rejects.toThrow(
        "Room is already full",
      );
    });

    it("rejects the host joining their own room", async () => {
      prisma.room.findUnique.mockResolvedValue(waitingRoom());
      await expect(service.joinPrivateRoom("host", "ABC123")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("answers 409 when another guest wins the claim", async () => {
      prisma.room.findUnique.mockResolvedValue(waitingRoom());
      tx.room.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.joinPrivateRoom("guest", "ABC123")).rejects.toThrow(
        "Room is already full",
      );
      expect(tx.match.create).not.toHaveBeenCalled();
    });

    it("notifies match_found listeners with usernames", async () => {
      prisma.room.findUnique.mockResolvedValue(waitingRoom());
      prisma.player.findMany.mockResolvedValue([
        { id: "host", username: "Host" },
        { id: "guest", username: "Guest" },
      ]);
      const events: IMatchFoundEvent[] = [];
      service.onMatchFound((e) => events.push(e));

      await service.joinPrivateRoom("guest", "ABC123");

      expect(events).toEqual([
        {
          matchId: "match-1",
          roomId: "room-1",
          players: [
            { id: "host", username: "Host" },
            { id: "guest", username: "Guest" },
          ],
        },
      ]);
    });

    it("still succeeds when the notification lookup fails", async () => {
      prisma.room.findUnique.mockResolvedValue(waitingRoom());
      prisma.player.findMany.mockRejectedValue(new Error("db"));
      service.onMatchFound(jest.fn());

      await expect(
        service.joinPrivateRoom("guest", "ABC123"),
      ).resolves.toBeDefined();
    });
  });

  describe("global queue", () => {
    const ticket = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        elo: 1000,
        maxTurns: 12,
        joinedAt: NOW.getTime(),
        ...overrides,
      });

    it("answers 503 when Redis is not available at all", async () => {
      redisService.getClient.mockReturnValue(null);

      await expect(service.joinGlobalQueue("p1")).rejects.toThrow(
        ServiceUnavailableException,
      );
      await expect(service.leaveGlobalQueue("p1")).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it("answers 503 when a Redis command fails while joining", async () => {
      redis.zrange.mockRejectedValue(new Error("ECONNRESET"));

      const error = await service.joinGlobalQueue("p1").catch((e) => e);

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error.message).toBe("Matchmaking is unavailable");
    });

    it("answers 503 when Redis fails while leaving", async () => {
      redis.zrem.mockRejectedValue(new Error("ECONNRESET"));
      await expect(service.leaveGlobalQueue("p1")).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it("throws 404 when the player does not exist", async () => {
      prisma.player.findFirst.mockResolvedValue(null);
      await expect(service.joinGlobalQueue("ghost")).rejects.toThrow(
        NotFoundException,
      );
    });

    it("queues the player with a ticket when nobody is waiting", async () => {
      redis.zrank.mockResolvedValue(2);

      const result = await service.joinGlobalQueue("p1", 10);

      expect(result).toEqual({
        status: "queued",
        queuePosition: 3,
        estimatedWait: 30,
      });
      expect(redis.set).toHaveBeenCalledWith(
        TICKET + "p1",
        JSON.stringify({ elo: 1000, maxTurns: 10, joinedAt: NOW.getTime() }),
        "EX",
        300,
      );
      expect(redis.zadd).toHaveBeenCalledWith(QUEUE_KEY, NOW.getTime(), "p1");
    });

    it("keeps the original queue position when re-joining", async () => {
      redis.zscore.mockResolvedValue("1700000000000");

      await service.joinGlobalQueue("p1");

      expect(redis.zadd).toHaveBeenCalledWith(
        QUEUE_KEY,
        1_700_000_000_000,
        "p1",
      );
    });

    it("matches with a waiting player inside the ELO range and creates a ranked GLOBAL match", async () => {
      redis.zrange.mockResolvedValue(["p2"]);
      redis.get.mockResolvedValue(ticket({ elo: 1150 }));

      const result = await service.joinGlobalQueue("p1");

      expect(result.status).toBe("matched");
      expect(redis.zrem).toHaveBeenCalledWith(QUEUE_KEY, "p2");
      expect(redis.del).toHaveBeenCalledWith(TICKET + "p2");
      const data = tx.match.create.mock.calls[0][0].data;
      expect(data).toMatchObject({ mode: "GLOBAL", isRanked: true });
      const seats = data.participants.create.map(
        (p: { playerId: string }) => p.playerId,
      );
      expect([...seats].sort()).toEqual(["p1", "p2"]);
      expect(JSON.stringify(result)).not.toContain("secretNumber");
    });

    it("does not match players outside the base ELO range (200) on a fresh ticket", async () => {
      redis.zrange.mockResolvedValue(["p2"]);
      redis.get.mockResolvedValue(ticket({ elo: 1201 }));

      const result = await service.joinGlobalQueue("p1");

      expect(result.status).toBe("queued");
      expect(tx.match.create).not.toHaveBeenCalled();
    });

    it("matches exactly at the base range boundary", async () => {
      redis.zrange.mockResolvedValue(["p2"]);
      redis.get.mockResolvedValue(ticket({ elo: 1200 }));

      expect((await service.joinGlobalQueue("p1")).status).toBe("matched");
    });

    it("widens the range by 50 every 10 seconds waited", async () => {
      redis.zrange.mockResolvedValue(["p2"]);
      // waited 40s => 4 steps => range 400
      redis.get.mockResolvedValue(
        ticket({ elo: 1400, joinedAt: NOW.getTime() - 40_000 }),
      );

      expect((await service.joinGlobalQueue("p1")).status).toBe("matched");
    });

    it("does not widen beyond the 1000 cap", async () => {
      redis.zrange.mockResolvedValue(["p2"]);
      redis.get.mockResolvedValue(
        ticket({ elo: 2100, joinedAt: NOW.getTime() - 3_600_000 }),
      );

      expect((await service.joinGlobalQueue("p1")).status).toBe("queued");
    });

    it("does not match players with a different maxTurns", async () => {
      redis.zrange.mockResolvedValue(["p2"]);
      redis.get.mockResolvedValue(ticket({ maxTurns: 8 }));

      expect((await service.joinGlobalQueue("p1")).status).toBe("queued");
    });

    it("drops candidates without ticket or with a corrupt ticket", async () => {
      redis.zrange.mockResolvedValue(["gone", "corrupt", "badshape", "self"]);
      redis.get.mockImplementation(async (key: string) => {
        if (key === TICKET + "gone") return null;
        if (key === TICKET + "corrupt") return "{not json";
        if (key === TICKET + "badshape") return JSON.stringify({ elo: "x" });
        return null;
      });

      const result = await service.joinGlobalQueue("self");

      expect(result.status).toBe("queued");
      expect(redis.zrem).toHaveBeenCalledWith(QUEUE_KEY, "gone");
      expect(redis.zrem).toHaveBeenCalledWith(QUEUE_KEY, "corrupt");
      expect(redis.zrem).toHaveBeenCalledWith(QUEUE_KEY, "badshape");
    });

    it("skips a candidate claimed by someone else (ZREM returns 0)", async () => {
      redis.zrange.mockResolvedValue(["p2", "p3"]);
      redis.get.mockResolvedValue(ticket());
      // 1st zrem: self removal; 2nd: p2 lost; 3rd: p3 claimed
      redis.zrem
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(0)
        .mockResolvedValueOnce(1);

      await service.joinGlobalQueue("p1");

      const seats =
        tx.match.create.mock.calls[0][0].data.participants.create.map(
          (p: { playerId: string }) => p.playerId,
        );
      expect(seats).toContain("p3");
      expect(seats).not.toContain("p2");
    });

    it("re-queues the opponent when match creation fails", async () => {
      redis.zrange.mockResolvedValue(["p2"]);
      const t = ticket({ elo: 1100, joinedAt: 123 });
      redis.get.mockResolvedValue(t);
      prisma.$transaction.mockRejectedValue(new ConflictException("boom"));

      await expect(service.joinGlobalQueue("p1")).rejects.toThrow(
        ConflictException,
      );

      expect(redis.zadd).toHaveBeenCalledWith(QUEUE_KEY, 123, "p2");
      expect(redis.set).toHaveBeenCalledWith(
        TICKET + "p2",
        JSON.stringify({ elo: 1100, maxTurns: 12, joinedAt: 123 }),
        "EX",
        300,
      );
    });

    it("leaves the queue by removing membership and ticket", async () => {
      await expect(service.leaveGlobalQueue("p1")).resolves.toEqual({
        message: "Left matchmaking queue",
      });
      expect(redis.zrem).toHaveBeenCalledWith(QUEUE_KEY, "p1");
      expect(redis.del).toHaveBeenCalledWith(TICKET + "p1");
    });
  });
});

import { createHash } from "crypto";
import { Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Language, MatchStatus, Rank } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { PublicService } from "./public.service";

const sha256 = (v: string): string =>
  createHash("sha256").update(v).digest("hex");

describe("PublicService", () => {
  let service: PublicService;
  let prisma: {
    waitlistSubscriber: { upsert: jest.Mock };
    contactMessage: { create: jest.Mock };
    player: { count: jest.Mock; findMany: jest.Mock; findFirst: jest.Mock };
    match: { count: jest.Mock };
  };
  let configValues: Record<string, string | undefined>;

  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date("2025-05-10T15:30:00Z"));
    configValues = {};
    prisma = {
      waitlistSubscriber: { upsert: jest.fn().mockResolvedValue({ id: "w1" }) },
      contactMessage: { create: jest.fn().mockResolvedValue({ id: "c1" }) },
      player: {
        count: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
      },
      match: { count: jest.fn() },
    };
    service = new PublicService(
      prisma as unknown as PrismaService,
      {
        get: (key: string) => configValues[key],
      } as unknown as ConfigService,
    );
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("joinWaitlist", () => {
    it("upserts without overwriting existing rows (idempotent)", async () => {
      await service.joinWaitlist({
        email: "a@b.com",
        locale: "pt",
        source: " hero ",
      });

      expect(prisma.waitlistSubscriber.upsert).toHaveBeenCalledWith({
        where: { email: "a@b.com" },
        create: { email: "a@b.com", locale: Language.PT, source: "hero" },
        update: {},
        select: { id: true },
      });
    });

    it("defaults the locale to ES and blank source to null", async () => {
      await service.joinWaitlist({ email: "a@b.com", source: "   " });

      expect(prisma.waitlistSubscriber.upsert.mock.calls[0][0].create).toEqual({
        email: "a@b.com",
        locale: Language.ES,
        source: null,
      });
    });

    it("answers identically for new and existing emails", async () => {
      const first = await service.joinWaitlist({ email: "a@b.com" });
      const second = await service.joinWaitlist({ email: "a@b.com" });

      expect(first).toEqual({ subscribed: true });
      expect(second).toEqual(first);
    });
  });

  describe("createContactMessage", () => {
    const dto = {
      name: "Ann",
      email: "ann@x.com",
      subject: "Hi",
      message: "Hello",
    };

    it("stores a SHA-256 hash of ip+salt and never the raw ip", async () => {
      configValues.CONTACT_IP_SALT = "pepper";

      await expect(
        service.createContactMessage(dto, "203.0.113.9"),
      ).resolves.toEqual({ received: true });

      const data = prisma.contactMessage.create.mock.calls[0][0].data;
      expect(data.ipHash).toBe(sha256("203.0.113.9pepper"));
      expect(data.ipHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(data)).not.toContain("203.0.113.9");
    });

    it("falls back to the default salt when none is configured", async () => {
      await service.createContactMessage(dto, "1.1.1.1");

      expect(prisma.contactMessage.create.mock.calls[0][0].data.ipHash).toBe(
        sha256("1.1.1.1picopala-contact-default-salt"),
      );
    });

    it("produces different hashes for different salts", async () => {
      configValues.CONTACT_IP_SALT = "s1";
      await service.createContactMessage(dto, "1.1.1.1");
      configValues.CONTACT_IP_SALT = "s2";
      await service.createContactMessage(dto, "1.1.1.1");

      const [a, b] = prisma.contactMessage.create.mock.calls.map(
        (c) => c[0].data.ipHash,
      );
      expect(a).not.toBe(b);
    });
  });

  describe("getStats", () => {
    it("counts non-deleted players and finished matches, today since UTC midnight", async () => {
      prisma.player.count.mockResolvedValue(10);
      prisma.match.count.mockResolvedValueOnce(100).mockResolvedValueOnce(7);

      const stats = await service.getStats();

      expect(stats).toEqual({
        totalPlayers: 10,
        totalMatches: 100,
        matchesToday: 7,
      });
      expect(prisma.player.count).toHaveBeenCalledWith({
        where: { deletedAt: null },
      });
      expect(prisma.match.count).toHaveBeenNthCalledWith(2, {
        where: {
          status: MatchStatus.FINISHED,
          finishedAt: { gte: new Date("2025-05-10T00:00:00.000Z") },
        },
      });
    });

    it("serves from cache for 60 seconds", async () => {
      prisma.player.count.mockResolvedValue(1);
      prisma.match.count.mockResolvedValue(1);

      await service.getStats();
      jest.advanceTimersByTime(59_000);
      await service.getStats();
      expect(prisma.player.count).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(2_000);
      await service.getStats();
      expect(prisma.player.count).toHaveBeenCalledTimes(2);
    });
  });

  describe("getAppLinks", () => {
    it("maps configured values and nulls for missing/empty ones", () => {
      configValues.APP_STORE_URL = "https://apple";
      configValues.PLAY_STORE_URL = "";
      configValues.APP_VERSION = "1.2.3";

      expect(service.getAppLinks()).toEqual({
        ios: "https://apple",
        android: null,
        version: "1.2.3",
        minVersion: null,
      });
    });
  });

  describe("getLeaderboard", () => {
    it("returns positions with only public fields", async () => {
      prisma.player.findMany.mockResolvedValue([
        {
          username: "Top",
          avatarUrl: null,
          elo: 2100,
          rank: Rank.PLATINO,
          stats: [{ wins: 3 }, { wins: 4 }],
          // Defensive: even if the query leaked extra columns they must not pass through.
          email: "top@x.com",
          passwordHash: "hash",
          id: "secret-id",
        },
        {
          username: "Second",
          avatarUrl: "https://res.cloudinary.com/x.png",
          elo: 1900,
          rank: Rank.ORO,
          stats: [],
        },
      ]);

      const board = await service.getLeaderboard(20, 40);

      expect(board).toEqual([
        {
          position: 41,
          username: "Top",
          avatarUrl: null,
          elo: 2100,
          rank: Rank.PLATINO,
          wins: 7,
        },
        {
          position: 42,
          username: "Second",
          avatarUrl: "https://res.cloudinary.com/x.png",
          elo: 1900,
          rank: Rank.ORO,
          wins: 0,
        },
      ]);
      for (const entry of board) {
        expect(Object.keys(entry).sort()).toEqual(
          ["avatarUrl", "elo", "position", "rank", "username", "wins"].sort(),
        );
      }
      const json = JSON.stringify(board);
      expect(json).not.toMatch(/email|passwordHash|secret-id/);
    });

    it("queries only active players with games, never selecting sensitive columns", async () => {
      prisma.player.findMany.mockResolvedValue([]);

      await service.getLeaderboard(10, 0);

      const args = prisma.player.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        deletedAt: null,
        stats: { some: { games: { gt: 0 } } },
      });
      expect(Object.keys(args.select).sort()).toEqual(
        ["avatarUrl", "elo", "rank", "stats", "username"].sort(),
      );
      expect(args).toMatchObject({ skip: 0, take: 10 });
    });

    it("caches per limit/offset pair", async () => {
      prisma.player.findMany.mockResolvedValue([]);

      await service.getLeaderboard(10, 0);
      await service.getLeaderboard(10, 0);
      await service.getLeaderboard(10, 10);

      expect(prisma.player.findMany).toHaveBeenCalledTimes(2);
    });
  });

  describe("getPlayerProfile", () => {
    it("aggregates stats across modes and exposes only public fields", async () => {
      const createdAt = new Date("2024-01-01T00:00:00Z");
      prisma.player.findFirst.mockResolvedValue({
        username: "Ann",
        avatarUrl: null,
        elo: 1200,
        rank: Rank.PLATA,
        createdAt,
        stats: [
          { games: 3, wins: 2, losses: 1, draws: 0 },
          { games: 2, wins: 0, losses: 1, draws: 1 },
        ],
      });

      const profile = await service.getPlayerProfile("ann");

      expect(profile).toEqual({
        username: "Ann",
        avatarUrl: null,
        elo: 1200,
        rank: Rank.PLATA,
        createdAt,
        stats: { games: 5, wins: 2, losses: 2, draws: 1 },
      });
      expect(prisma.player.findFirst.mock.calls[0][0].where).toEqual({
        username: { equals: "ann", mode: "insensitive" },
        deletedAt: null,
      });
      expect(
        prisma.player.findFirst.mock.calls[0][0].select,
      ).not.toHaveProperty("email");
    });

    it("throws 404 for unknown players", async () => {
      prisma.player.findFirst.mockResolvedValue(null);

      await expect(service.getPlayerProfile("nobody")).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});

import { createHash } from "crypto";
import { ConflictException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Language, Platform, Player, Prisma, Rank } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { PrismaService } from "../prisma/prisma.service";
import { AuthService } from "./auth.service";
import { RegisterBaseDto } from "./dto/register-base.dto";

jest.mock("bcrypt", () => ({
  hash: jest.fn(),
  compare: jest.fn(),
}));

const bcryptHash = bcrypt.hash as unknown as jest.Mock;
const bcryptCompare = bcrypt.compare as unknown as jest.Mock;

const sha256 = (v: string): string =>
  createHash("sha256").update(v).digest("hex");

interface IPrismaMock {
  player: {
    findFirst: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  session: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    updateMany: jest.Mock;
    deleteMany: jest.Mock;
  };
}

const makePlayer = (overrides: Partial<Player> = {}): Player =>
  ({
    id: "player-1",
    username: "Alice",
    email: "alice@example.com",
    passwordHash: "stored-hash",
    language: Language.EN,
    avatarUrl: null,
    elo: 1000,
    rank: Rank.PLATA,
    createdAt: new Date("2025-01-01T00:00:00Z"),
    deletedAt: null,
    ...overrides,
  }) as Player;

describe("AuthService", () => {
  let service: AuthService;
  let prisma: IPrismaMock;
  let jwt: { signAsync: jest.Mock; decode: jest.Mock };
  let config: { get: jest.Mock };
  let signCounter: number;

  beforeEach(() => {
    jest.clearAllMocks();
    signCounter = 0;

    prisma = {
      player: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      session: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    jwt = {
      signAsync: jest.fn().mockImplementation(async () => {
        signCounter += 1;
        return `token-${signCounter}`;
      }),
      decode: jest.fn().mockReturnValue({ exp: 2_000_000_000 }),
    };
    config = {
      get: jest.fn((key: string, fallback?: string) => fallback ?? key),
    };
    bcryptHash.mockResolvedValue("hashed");
    bcryptCompare.mockResolvedValue(true);

    // Casts are limited to the mocks: only the members used by the service exist.
    service = new AuthService(
      prisma as unknown as PrismaService,
      jwt as unknown as JwtService,
      config as unknown as ConfigService,
    );
  });

  const registerDto: RegisterBaseDto = {
    username: "Alice",
    email: "alice@example.com",
    password: "password123",
  };

  describe("register", () => {
    it("hashes the password, creates the player and returns tokens without secrets", async () => {
      prisma.player.findFirst.mockResolvedValue(null);
      prisma.player.create.mockResolvedValue(makePlayer());

      const result = await service.register(registerDto, Platform.WEB, "jest-agent");

      expect(bcryptHash).toHaveBeenCalledWith("password123", 12);
      expect(prisma.player.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          username: "Alice",
          email: "alice@example.com",
          passwordHash: "hashed",
          language: Language.EN,
        }),
      });
      expect(result.accessToken).toBe("token-1");
      expect(result.refreshToken).toBe("token-2");
      expect(JSON.stringify(result)).not.toContain("stored-hash");
      expect(result.player).not.toHaveProperty("passwordHash");
    });

    it("maps the requested language and stores the platform given by the controller", async () => {
      prisma.player.findFirst.mockResolvedValue(null);
      prisma.player.create.mockResolvedValue(makePlayer());

      await service.register({ ...registerDto, language: "pt" }, Platform.WEB);

      expect(prisma.player.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ language: Language.PT }),
      });
      expect(prisma.session.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ platform: Platform.WEB }),
      });
    });

    it("throws a generic 409 when username or email already exist", async () => {
      prisma.player.findFirst.mockResolvedValue({ id: "x" });

      const error = await service.register(registerDto, Platform.WEB).catch((e) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).message).toBe(
        "Username or email already in use",
      );
      expect(prisma.player.create).not.toHaveBeenCalled();
    });

    it("returns the same generic 409 when a unique race is lost (P2002)", async () => {
      prisma.player.findFirst.mockResolvedValue(null);
      prisma.player.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("dup", {
          code: "P2002",
          clientVersion: "test",
        }),
      );

      await expect(service.register(registerDto, Platform.WEB)).rejects.toThrow(
        "Username or email already in use",
      );
    });

    it("rethrows unexpected persistence errors untouched", async () => {
      prisma.player.findFirst.mockResolvedValue(null);
      const boom = new Error("db down");
      prisma.player.create.mockRejectedValue(boom);

      await expect(service.register(registerDto, Platform.WEB)).rejects.toBe(boom);
    });

    it("queries the username case-insensitively", async () => {
      prisma.player.findFirst.mockResolvedValue({ id: "x" });
      await service.register(registerDto, Platform.WEB).catch(() => undefined);

      expect(prisma.player.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { username: { equals: "Alice", mode: "insensitive" } },
              { email: "alice@example.com" },
            ],
          },
        }),
      );
    });
  });

  describe("login", () => {
    const loginDto = { username: "alice", password: "password123" };

    it("returns tokens and public player data for valid credentials", async () => {
      prisma.player.findFirst.mockResolvedValue(makePlayer());

      const result = await service.login(loginDto, Platform.WEB, "agent");

      expect(bcryptCompare).toHaveBeenCalledWith("password123", "stored-hash");
      expect(result.accessToken).toBe("token-1");
      expect(result.player.username).toBe("Alice");
      expect(result.player).not.toHaveProperty("passwordHash");
      expect(prisma.player.update).toHaveBeenCalledWith({
        where: { id: "player-1" },
        data: { lastSeenAt: expect.any(Date) },
      });
    });

    it("rejects a wrong password", async () => {
      prisma.player.findFirst.mockResolvedValue(makePlayer());
      bcryptCompare.mockResolvedValue(false);

      await expect(service.login(loginDto, Platform.WEB)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(prisma.session.create).not.toHaveBeenCalled();
    });

    it("rejects an unknown user but still runs bcrypt against a dummy hash", async () => {
      prisma.player.findFirst.mockResolvedValue(null);
      bcryptHash.mockResolvedValue("dummy-hash");
      bcryptCompare.mockResolvedValue(true);

      await expect(service.login(loginDto, Platform.WEB)).rejects.toThrow(
        "Invalid credentials",
      );
      expect(bcryptCompare).toHaveBeenCalledWith("password123", "dummy-hash");
    });

    it("rejects a player with a null passwordHash even if compare returns true", async () => {
      prisma.player.findFirst.mockResolvedValue(
        makePlayer({ passwordHash: null }),
      );
      bcryptHash.mockResolvedValue("dummy-hash");
      bcryptCompare.mockResolvedValue(true);

      await expect(service.login(loginDto, Platform.WEB)).rejects.toThrow(
        UnauthorizedException,
      );
      expect(bcryptCompare).toHaveBeenCalledTimes(1);
    });

    it("filters out soft-deleted players in the lookup", async () => {
      prisma.player.findFirst.mockResolvedValue(null);

      await service.login(loginDto, Platform.WEB).catch(() => undefined);

      expect(prisma.player.findFirst).toHaveBeenCalledWith({
        where: {
          username: { equals: "alice", mode: "insensitive" },
          deletedAt: null,
        },
      });
    });

    it("computes the dummy hash only once across failed logins", async () => {
      prisma.player.findFirst.mockResolvedValue(null);
      bcryptHash.mockResolvedValue("dummy-hash");

      await service.login(loginDto, Platform.WEB).catch(() => undefined);
      await service.login(loginDto, Platform.WEB).catch(() => undefined);

      expect(bcryptHash).toHaveBeenCalledTimes(1);
      expect(bcryptCompare).toHaveBeenCalledTimes(2);
    });
  });

  describe("refreshTokens", () => {
    const rawToken = "refresh-raw";
    const futureSession = (overrides: Record<string, unknown> = {}) => ({
      id: "session-1",
      playerId: "player-1",
      familyId: "family-1",
      platform: Platform.IOS,
      userAgent: "stored-agent",
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    });

    it("rotates the token, keeping the family and revoking the old session", async () => {
      prisma.session.findUnique.mockResolvedValue(futureSession());
      prisma.player.findFirst.mockResolvedValue(makePlayer());

      const result = await service.refreshTokens("player-1", rawToken);

      expect(prisma.session.findUnique).toHaveBeenCalledWith({
        where: { tokenHash: sha256(rawToken) },
      });
      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { id: "session-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(prisma.session.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          playerId: "player-1",
          familyId: "family-1",
          platform: Platform.IOS,
          userAgent: "stored-agent",
          tokenHash: sha256("token-2"),
        }),
      });
      expect(result).toEqual({
        accessToken: "token-1",
        refreshToken: "token-2",
      });
    });

    it("revokes the whole family and returns 401 when a revoked token is reused", async () => {
      prisma.session.findUnique.mockResolvedValue(
        futureSession({ revokedAt: new Date() }),
      );

      await expect(service.refreshTokens("player-1", rawToken)).rejects.toThrow(
        UnauthorizedException,
      );

      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { familyId: "family-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(prisma.session.create).not.toHaveBeenCalled();
    });

    it("rejects an unknown token", async () => {
      prisma.session.findUnique.mockResolvedValue(null);

      await expect(service.refreshTokens("player-1", rawToken)).rejects.toThrow(
        "Invalid refresh token",
      );
    });

    it("rejects a token that belongs to another player without revoking anything", async () => {
      prisma.session.findUnique.mockResolvedValue(
        futureSession({ playerId: "someone-else" }),
      );

      await expect(service.refreshTokens("player-1", rawToken)).rejects.toThrow(
        "Invalid refresh token",
      );
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it("rejects an expired session", async () => {
      prisma.session.findUnique.mockResolvedValue(
        futureSession({ expiresAt: new Date(Date.now() - 1000) }),
      );

      await expect(service.refreshTokens("player-1", rawToken)).rejects.toThrow(
        "Refresh token expired",
      );
    });

    it("rejects when the player no longer exists", async () => {
      prisma.session.findUnique.mockResolvedValue(futureSession());
      prisma.player.findFirst.mockResolvedValue(null);

      await expect(service.refreshTokens("player-1", rawToken)).rejects.toThrow(
        "Player not found",
      );
    });

    it("revokes the family and returns 401 when the atomic claim loses the race", async () => {
      prisma.session.findUnique.mockResolvedValue(futureSession());
      prisma.player.findFirst.mockResolvedValue(makePlayer());
      prisma.session.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 3 });

      await expect(service.refreshTokens("player-1", rawToken)).rejects.toThrow(
        UnauthorizedException,
      );

      expect(prisma.session.updateMany).toHaveBeenLastCalledWith({
        where: { familyId: "family-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(prisma.session.create).not.toHaveBeenCalled();
    });

    it("prefers the new user agent and truncates it to 512 chars", async () => {
      prisma.session.findUnique.mockResolvedValue(futureSession());
      prisma.player.findFirst.mockResolvedValue(makePlayer());

      await service.refreshTokens("player-1", rawToken, "x".repeat(1000));

      const data = prisma.session.create.mock.calls[0][0].data;
      expect(data.userAgent).toHaveLength(512);
    });

    it("fails when the signed refresh token has no exp claim", async () => {
      prisma.session.findUnique.mockResolvedValue(futureSession());
      prisma.player.findFirst.mockResolvedValue(makePlayer());
      jwt.decode.mockReturnValue({});

      await expect(service.refreshTokens("player-1", rawToken)).rejects.toThrow(
        "missing the exp claim",
      );
    });
  });

  describe("logout", () => {
    it("revokes the whole family of the presented token", async () => {
      prisma.session.findUnique.mockResolvedValue({
        playerId: "player-1",
        familyId: "family-1",
      });

      const result = await service.logout("player-1", "raw");

      expect(prisma.session.updateMany).toHaveBeenCalledWith({
        where: { familyId: "family-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      expect(result).toEqual({ message: "Logged out successfully" });
    });

    it("does not revoke sessions of another player but still answers OK", async () => {
      prisma.session.findUnique.mockResolvedValue({
        playerId: "other",
        familyId: "family-9",
      });

      await expect(service.logout("player-1", "raw")).resolves.toEqual({
        message: "Logged out successfully",
      });
      expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });

    it("is a no-op for unknown tokens", async () => {
      prisma.session.findUnique.mockResolvedValue(null);

      await service.logout("player-1", "raw");

      expect(prisma.session.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("session pruning", () => {
    it("keeps the 10 newest active sessions and deletes the surplus", async () => {
      prisma.player.findFirst.mockResolvedValue(makePlayer());
      prisma.session.findMany.mockResolvedValue([{ id: "s11" }, { id: "s12" }]);

      await service.login({ username: "alice", password: "password123" }, Platform.WEB);

      expect(prisma.session.findMany).toHaveBeenCalledWith({
        where: {
          playerId: "player-1",
          revokedAt: null,
          expiresAt: { gt: expect.any(Date) },
        },
        orderBy: { createdAt: "desc" },
        skip: 10,
        select: { id: true },
      });
      expect(prisma.session.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["s11", "s12"] } },
      });
    });

    it("does not delete anything when under the limit", async () => {
      prisma.player.findFirst.mockResolvedValue(makePlayer());

      await service.login({ username: "alice", password: "password123" }, Platform.WEB);

      expect(prisma.session.deleteMany).not.toHaveBeenCalled();
    });
  });
});

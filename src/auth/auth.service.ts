import { createHash, randomUUID } from "crypto";
import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { Language, Platform, Player, Prisma } from "@prisma/client";
import * as bcrypt from "bcrypt";
import { JwtPayload } from "../common/interfaces/jwt-payload.interface";
import { PrismaService } from "../prisma/prisma.service";
import { LoginBaseDto } from "./dto/login-base.dto";
import { RegisterBaseDto } from "./dto/register-base.dto";

const BCRYPT_COST = 12;
const MAX_ACTIVE_SESSIONS = 10;
const MAX_USER_AGENT_LENGTH = 512;

const LANGUAGE_MAP: Record<string, Language> = {
  es: Language.ES,
  en: Language.EN,
  pt: Language.PT,
};

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private dummyHash: Promise<string> | null = null;

  constructor(
    private prismaService: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async register(
    registerDto: RegisterBaseDto,
    platform: Platform,
    userAgent?: string,
  ) {
    const existingPlayer = await this.prismaService.player.findFirst({
      where: {
        OR: [
          { username: { equals: registerDto.username, mode: "insensitive" } },
          { email: registerDto.email },
        ],
      },
      select: { id: true },
    });

    if (existingPlayer) {
      throw this.conflict();
    }

    const passwordHash = await bcrypt.hash(registerDto.password, BCRYPT_COST);

    let player: Player;
    try {
      player = await this.prismaService.player.create({
        data: {
          username: registerDto.username,
          email: registerDto.email,
          passwordHash,
          language: LANGUAGE_MAP[registerDto.language ?? "en"] ?? Language.EN,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw this.conflict();
      }
      throw error;
    }

    const tokens = await this.startSession(player, platform, userAgent);

    return { ...tokens, player: this.toPublicPlayer(player) };
  }

  async login(loginDto: LoginBaseDto, platform: Platform, userAgent?: string) {
    const player = await this.prismaService.player.findFirst({
      where: {
        username: { equals: loginDto.username, mode: "insensitive" },
        deletedAt: null,
      },
    });

    // Always run a bcrypt comparison to keep timing uniform.
    const hashToCompare = player?.passwordHash ?? (await this.getDummyHash());
    const isPasswordValid = await bcrypt.compare(
      loginDto.password,
      hashToCompare,
    );

    if (!player || !player.passwordHash || !isPasswordValid) {
      throw new UnauthorizedException("Invalid credentials");
    }

    const tokens = await this.startSession(player, platform, userAgent);

    await this.prismaService.player.update({
      where: { id: player.id },
      data: { lastSeenAt: new Date() },
    });

    return { ...tokens, player: this.toPublicPlayer(player) };
  }

  async refreshTokens(
    playerId: string,
    refreshToken: string,
    userAgent?: string,
  ) {
    const tokenHash = this.hashToken(refreshToken);
    const session = await this.prismaService.session.findUnique({
      where: { tokenHash },
    });

    if (!session || session.playerId !== playerId) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    if (session.revokedAt) {
      // Reuse of a rotated token: assume theft and kill the whole family.
      await this.revokeFamily(session.familyId);
      throw new UnauthorizedException("Invalid refresh token");
    }

    if (session.expiresAt <= new Date()) {
      throw new UnauthorizedException("Refresh token expired");
    }

    const player = await this.prismaService.player.findFirst({
      where: { id: playerId, deletedAt: null },
    });

    if (!player) {
      throw new UnauthorizedException("Player not found");
    }

    // Atomic claim: only one concurrent request can revoke this session.
    const claimed = await this.prismaService.session.updateMany({
      where: { id: session.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    if (claimed.count === 0) {
      await this.revokeFamily(session.familyId);
      throw new UnauthorizedException("Invalid refresh token");
    }

    return this.issueTokens(player, {
      platform: session.platform,
      userAgent: userAgent ?? session.userAgent ?? undefined,
      familyId: session.familyId,
    });
  }

  async logout(playerId: string, refreshToken: string) {
    const session = await this.prismaService.session.findUnique({
      where: { tokenHash: this.hashToken(refreshToken) },
      select: { playerId: true, familyId: true },
    });

    if (session && session.playerId === playerId) {
      await this.revokeFamily(session.familyId);
    }

    return { message: "Logged out successfully" };
  }

  private async startSession(
    player: Player,
    platform: Platform,
    userAgent?: string,
  ): Promise<IssuedTokens> {
    const tokens = await this.issueTokens(player, {
      platform,
      userAgent,
      familyId: randomUUID(),
    });
    await this.pruneSessions(player.id);
    return tokens;
  }

  private async issueTokens(
    player: Pick<Player, "id" | "username">,
    opts: { platform: Platform; userAgent?: string; familyId: string },
  ): Promise<IssuedTokens> {
    const payload: JwtPayload = { sub: player.id, username: player.username };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>("JWT_SECRET"),
        expiresIn: this.configService.get<string>("JWT_EXPIRES_IN", "15m"),
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>("JWT_REFRESH_SECRET"),
        expiresIn: this.configService.get<string>(
          "JWT_REFRESH_EXPIRES_IN",
          "7d",
        ),
        // Unique jti guarantees distinct tokens (and hashes) within the same second.
        jwtid: randomUUID(),
      }),
    ]);

    const decoded = this.jwtService.decode<JwtPayload | null>(refreshToken);
    if (!decoded?.exp) {
      throw new Error("Refresh token is missing the exp claim");
    }

    await this.prismaService.session.create({
      data: {
        playerId: player.id,
        tokenHash: this.hashToken(refreshToken),
        familyId: opts.familyId,
        platform: opts.platform,
        userAgent: opts.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
        expiresAt: new Date(decoded.exp * 1000),
      },
    });

    return { accessToken, refreshToken };
  }

  private async pruneSessions(playerId: string): Promise<void> {
    const stale = await this.prismaService.session.findMany({
      where: {
        playerId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
      skip: MAX_ACTIVE_SESSIONS,
      select: { id: true },
    });

    if (stale.length > 0) {
      await this.prismaService.session.deleteMany({
        where: { id: { in: stale.map((s) => s.id) } },
      });
    }
  }

  private async revokeFamily(familyId: string): Promise<void> {
    await this.prismaService.session.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  private hashToken(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  private getDummyHash(): Promise<string> {
    if (!this.dummyHash) {
      this.dummyHash = bcrypt.hash(randomUUID(), BCRYPT_COST);
    }
    return this.dummyHash;
  }

  private conflict(): ConflictException {
    return new ConflictException("Username or email already in use");
  }

  private toPublicPlayer(player: Player) {
    return {
      id: player.id,
      username: player.username,
      email: player.email,
      language: player.language,
      avatarUrl: player.avatarUrl,
      elo: player.elo,
      rank: player.rank,
      createdAt: player.createdAt,
    };
  }
}

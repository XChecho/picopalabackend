import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { GameMode, Language, MatchStatus, Platform, Prisma } from '@prisma/client';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { PrismaService } from '../prisma/prisma.service';
import { UpdatePlayerDto } from './dto/update-player.dto';

const LANGUAGE_MAP: Record<string, Language> = {
  es: Language.ES,
  en: Language.EN,
  pt: Language.PT,
};

const PROFILE_SELECT = {
  id: true,
  username: true,
  email: true,
  avatarUrl: true,
  language: true,
  elo: true,
  rank: true,
  createdAt: true,
} satisfies Prisma.PlayerSelect;

const MAX_PAGE_SIZE = 100;
const MAX_ELO_HISTORY = 50;

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), min), max);
}

function parseEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined || value === '') return undefined;
  const match = allowed.find((a) => a === value);
  if (!match) {
    throw new BadRequestException(`Invalid ${field}`);
  }
  return match;
}

@Injectable()
export class PlayerService {
  constructor(
    private prismaService: PrismaService,
    private cloudinaryService: CloudinaryService,
  ) {}

  async getProfile(playerId: string) {
    const player = await this.prismaService.player.findFirst({
      where: { id: playerId, deletedAt: null },
      select: PROFILE_SELECT,
    });

    if (!player) {
      throw new NotFoundException('Player not found');
    }

    return player;
  }

  async updateProfile(playerId: string, updatePlayerDto: UpdatePlayerDto) {
    await this.assertActive(playerId);

    if (updatePlayerDto.username) {
      const existing = await this.prismaService.player.findFirst({
        where: {
          username: { equals: updatePlayerDto.username, mode: 'insensitive' },
          NOT: { id: playerId },
        },
        select: { id: true },
      });

      if (existing) {
        throw new ConflictException('Username already taken');
      }
    }

    const data: Prisma.PlayerUpdateInput = {};
    if (updatePlayerDto.username !== undefined) data.username = updatePlayerDto.username;
    if (updatePlayerDto.avatar !== undefined) data.avatarUrl = updatePlayerDto.avatar;
    if (updatePlayerDto.language !== undefined) {
      data.language = LANGUAGE_MAP[updatePlayerDto.language];
    }

    try {
      return await this.prismaService.player.update({
        where: { id: playerId },
        data,
        select: PROFILE_SELECT,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('Username already taken');
      }
      throw error;
    }
  }

  async getStats(playerId: string) {
    const rows = await this.prismaService.playerStats.findMany({
      where: { playerId },
    });

    const byMode = Object.values(GameMode).map((mode) => {
      const row = rows.find((r) => r.mode === mode);
      return {
        mode,
        games: row?.games ?? 0,
        wins: row?.wins ?? 0,
        losses: row?.losses ?? 0,
        draws: row?.draws ?? 0,
        currentStreak: row?.currentStreak ?? 0,
        bestStreak: row?.bestStreak ?? 0,
        bestAttempts: row?.bestAttempts ?? null,
        totalAttempts: row?.totalAttempts ?? 0,
        totalPicos: row?.totalPicos ?? 0,
        totalPalas: row?.totalPalas ?? 0,
        totalDurationSec: row?.totalDurationSec ?? 0,
      };
    });

    const sum = (pick: (r: (typeof byMode)[number]) => number) =>
      byMode.reduce((acc, r) => acc + pick(r), 0);
    const attempts = byMode
      .map((r) => r.bestAttempts)
      .filter((v): v is number => v !== null);
    const totalGames = sum((r) => r.games);
    const totalDurationSec = sum((r) => r.totalDurationSec);

    return {
      totalGames,
      wins: sum((r) => r.wins),
      losses: sum((r) => r.losses),
      draws: sum((r) => r.draws),
      currentStreak: Math.max(...byMode.map((r) => r.currentStreak)),
      bestStreak: Math.max(...byMode.map((r) => r.bestStreak)),
      bestAttempts: attempts.length > 0 ? Math.min(...attempts) : null,
      totalAttempts: sum((r) => r.totalAttempts),
      totalPicos: sum((r) => r.totalPicos),
      totalPalas: sum((r) => r.totalPalas),
      totalDurationSec,
      avgTimePerGame: totalGames > 0 ? Math.round(totalDurationSec / totalGames) : 0,
      byMode,
    };
  }

  async getMatchHistory(
    playerId: string,
    limit: number = 20,
    offset: number = 0,
    mode?: string,
    status?: string,
  ) {
    const take = clampInt(limit, 1, MAX_PAGE_SIZE, 20);
    const skip = clampInt(offset, 0, Number.MAX_SAFE_INTEGER, 0);

    const where: Prisma.MatchWhereInput = {
      participants: { some: { playerId } },
    };

    const parsedMode = parseEnum(mode, Object.values(GameMode), 'mode');
    const parsedStatus = parseEnum(status, Object.values(MatchStatus), 'status');
    if (parsedMode) where.mode = parsedMode;
    if (parsedStatus) where.status = parsedStatus;

    const [matches, total] = await Promise.all([
      this.prismaService.match.findMany({
        where,
        select: {
          id: true,
          mode: true,
          status: true,
          endReason: true,
          isRanked: true,
          maxTurns: true,
          aiDifficulty: true,
          startedAt: true,
          finishedAt: true,
          createdAt: true,
          participants: {
            orderBy: { seat: 'asc' },
            // secretNumber is intentionally never selected.
            select: {
              seat: true,
              playerId: true,
              isAi: true,
              result: true,
              attemptsUsed: true,
              eloBefore: true,
              eloAfter: true,
              player: { select: { username: true, avatarUrl: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take,
        skip,
      }),
      this.prismaService.match.count({ where }),
    ]);

    return {
      matches,
      total,
      limit: take,
      offset: skip,
    };
  }

  async updateAvatar(playerId: string, file: Express.Multer.File) {
    const player = await this.prismaService.player.findFirst({
      where: { id: playerId, deletedAt: null },
    });

    if (!player) {
      throw new NotFoundException('Player not found');
    }

    if (player.avatarUrl) {
      await this.cloudinaryService.deleteImage(player.avatarUrl);
    }

    const avatarUrl = await this.cloudinaryService.uploadImage(file);

    return this.prismaService.player.update({
      where: { id: playerId },
      data: { avatarUrl },
      select: PROFILE_SELECT,
    });
  }

  async updatePushToken(playerId: string, pushToken: string, platform?: Platform) {
    await this.assertActive(playerId);

    let resolved = platform;
    if (!resolved) {
      const lastSession = await this.prismaService.session.findFirst({
        where: { playerId, revokedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { platform: true },
      });
      resolved = lastSession?.platform;
    }

    if (!resolved) {
      throw new BadRequestException('platform is required');
    }

    const now = new Date();
    await this.prismaService.device.upsert({
      where: { pushToken },
      update: { playerId, platform: resolved, lastUsedAt: now },
      create: { playerId, platform: resolved, pushToken, lastUsedAt: now },
    });

    return { message: 'Push token updated' };
  }

  async getEloHistory(playerId: string, limit: number = 20) {
    const take = clampInt(limit, 1, MAX_ELO_HISTORY, 20);

    const rows = await this.prismaService.matchParticipant.findMany({
      where: {
        playerId,
        eloBefore: { not: null },
        eloAfter: { not: null },
        match: { finishedAt: { not: null } },
      },
      orderBy: { match: { finishedAt: 'desc' } },
      take,
      select: {
        eloBefore: true,
        eloAfter: true,
        rankBefore: true,
        rankAfter: true,
        result: true,
        match: {
          select: { id: true, mode: true, finishedAt: true },
        },
      },
    });

    return rows.map((row) => ({
      matchId: row.match.id,
      mode: row.match.mode,
      result: row.result,
      eloBefore: row.eloBefore,
      eloAfter: row.eloAfter,
      delta: (row.eloAfter ?? 0) - (row.eloBefore ?? 0),
      rankBefore: row.rankBefore,
      rankAfter: row.rankAfter,
      finishedAt: row.match.finishedAt,
    }));
  }

  private async assertActive(playerId: string): Promise<void> {
    const player = await this.prismaService.player.findFirst({
      where: { id: playerId, deletedAt: null },
      select: { id: true },
    });
    if (!player) {
      throw new NotFoundException('Player not found');
    }
  }
}

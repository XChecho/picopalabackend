import { createHash } from 'crypto';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Language, MatchStatus, Prisma, Rank } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ContactDto } from './dto/contact.dto';
import { WaitlistDto, WaitlistLocale } from './dto/waitlist.dto';
import { TtlCache } from './ttl-cache';

export interface IPublicStats {
  totalPlayers: number;
  totalMatches: number;
  matchesToday: number;
}

export interface IAppLinks {
  ios: string | null;
  android: string | null;
  version: string | null;
  minVersion: string | null;
}

export interface ILeaderboardEntry {
  position: number;
  username: string;
  avatarUrl: string | null;
  elo: number;
  rank: Rank;
  wins: number;
}

export interface IPublicPlayerProfile {
  username: string;
  avatarUrl: string | null;
  elo: number;
  rank: Rank;
  createdAt: Date;
  stats: { games: number; wins: number; losses: number; draws: number };
}

const CACHE_TTL_MS = 60_000;
// Used only when CONTACT_IP_SALT is not configured.
const DEFAULT_IP_SALT = 'picopala-contact-default-salt';

const LOCALE_MAP: Record<WaitlistLocale, Language> = {
  es: Language.ES,
  en: Language.EN,
  pt: Language.PT,
};

@Injectable()
export class PublicService {
  private readonly logger = new Logger(PublicService.name);
  private readonly statsCache = new TtlCache<IPublicStats>(CACHE_TTL_MS, 1);
  private readonly leaderboardCache = new TtlCache<ILeaderboardEntry[]>(CACHE_TTL_MS, 500);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async joinWaitlist(dto: WaitlistDto): Promise<{ subscribed: true }> {
    // Existing rows (including unsubscribed ones) are left untouched; the
    // response is identical either way to avoid email enumeration.
    await this.prisma.waitlistSubscriber.upsert({
      where: { email: dto.email },
      create: {
        email: dto.email,
        locale: dto.locale ? LOCALE_MAP[dto.locale] : Language.ES,
        source: dto.source?.trim() || null,
      },
      update: {},
      select: { id: true },
    });
    return { subscribed: true };
  }

  async createContactMessage(dto: ContactDto, ip: string): Promise<{ received: true }> {
    const salt = this.config.get<string>('CONTACT_IP_SALT') || DEFAULT_IP_SALT;
    const ipHash = createHash('sha256').update(`${ip}${salt}`).digest('hex');
    await this.prisma.contactMessage.create({
      data: {
        name: dto.name,
        email: dto.email,
        subject: dto.subject,
        message: dto.message,
        ipHash,
      },
      select: { id: true },
    });
    return { received: true };
  }

  getStats(): Promise<IPublicStats> {
    return this.statsCache.getOrLoad('stats', async () => {
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);
      const finished: Prisma.MatchWhereInput = { status: MatchStatus.FINISHED };

      const [totalPlayers, totalMatches, matchesToday] = await Promise.all([
        this.prisma.player.count({ where: { deletedAt: null } }),
        this.prisma.match.count({ where: finished }),
        this.prisma.match.count({
          where: { ...finished, finishedAt: { gte: startOfDay } },
        }),
      ]);
      return { totalPlayers, totalMatches, matchesToday };
    });
  }

  getAppLinks(): IAppLinks {
    const read = (key: string): string | null => this.config.get<string>(key) || null;
    return {
      ios: read('APP_STORE_URL'),
      android: read('PLAY_STORE_URL'),
      version: read('APP_VERSION'),
      minVersion: read('APP_MIN_VERSION'),
    };
  }

  getLeaderboard(limit: number, offset: number): Promise<ILeaderboardEntry[]> {
    return this.leaderboardCache.getOrLoad(`${limit}:${offset}`, async () => {
      const players = await this.prisma.player.findMany({
        where: { deletedAt: null, stats: { some: { games: { gt: 0 } } } },
        orderBy: [{ elo: 'desc' }, { createdAt: 'asc' }],
        skip: offset,
        take: limit,
        select: {
          username: true,
          avatarUrl: true,
          elo: true,
          rank: true,
          stats: { select: { wins: true } },
        },
      });
      return players.map((p, index) => ({
        position: offset + index + 1,
        username: p.username,
        avatarUrl: p.avatarUrl,
        elo: p.elo,
        rank: p.rank,
        wins: p.stats.reduce((sum, s) => sum + s.wins, 0),
      }));
    });
  }

  async getPlayerProfile(username: string): Promise<IPublicPlayerProfile> {
    const player = await this.prisma.player.findFirst({
      where: { username: { equals: username, mode: 'insensitive' }, deletedAt: null },
      select: {
        username: true,
        avatarUrl: true,
        elo: true,
        rank: true,
        createdAt: true,
        stats: { select: { games: true, wins: true, losses: true, draws: true } },
      },
    });
    if (!player) {
      this.logger.debug('Public profile not found');
      throw new NotFoundException('Player not found');
    }

    const stats = player.stats.reduce(
      (acc, s) => ({
        games: acc.games + s.games,
        wins: acc.wins + s.wins,
        losses: acc.losses + s.losses,
        draws: acc.draws + s.draws,
      }),
      { games: 0, wins: 0, losses: 0, draws: 0 },
    );

    return {
      username: player.username,
      avatarUrl: player.avatarUrl,
      elo: player.elo,
      rank: player.rank,
      createdAt: player.createdAt,
      stats,
    };
  }
}

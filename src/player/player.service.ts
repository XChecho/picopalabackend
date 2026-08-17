import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CloudinaryService } from '../cloudinary/cloudinary.service';
import { UpdatePlayerDto } from './dto/update-player.dto';

@Injectable()
export class PlayerService {
  constructor(
    private prismaService: PrismaService,
    private cloudinaryService: CloudinaryService,
  ) {}

  async getProfile(playerId: string) {
    const player = await this.prismaService.player.findUnique({
      where: { id: playerId },
      select: {
        id: true,
        username: true,
        email: true,
        avatar: true,
        language: true,
        createdAt: true,
      },
    });

    if (!player) {
      throw new NotFoundException('Player not found');
    }

    return player;
  }

  async updateProfile(playerId: string, updatePlayerDto: UpdatePlayerDto) {
    if (updatePlayerDto.username) {
      const existing = await this.prismaService.player.findFirst({
        where: {
          username: updatePlayerDto.username,
          NOT: { id: playerId },
        },
      });

      if (existing) {
        throw new ConflictException('Username already taken');
      }
    }

    return this.prismaService.player.update({
      where: { id: playerId },
      data: updatePlayerDto,
      select: {
        id: true,
        username: true,
        email: true,
        avatar: true,
        language: true,
        createdAt: true,
      },
    });
  }

  async getStats(playerId: string) {
    const stats = await this.prismaService.stats.findUnique({
      where: { playerId },
    });

    if (!stats) {
      throw new NotFoundException('Stats not found');
    }

    return {
      totalGames: stats.totalGames,
      wins: stats.wins,
      losses: stats.losses,
      draws: stats.draws,
      bestScore: stats.bestScore,
      currentStreak: stats.currentStreak,
      bestStreak: stats.bestStreak,
      avgTimePerGame: stats.avgTimePerGame,
      totalPicos: stats.totalPicos,
      totalPalas: stats.totalPalas,
    };
  }

  async getMatchHistory(
    playerId: string,
    limit: number = 20,
    offset: number = 0,
    mode?: string,
    status?: string,
  ) {
    const where: Record<string, unknown> = {
      OR: [
        { player1Id: playerId },
        { player2Id: playerId },
      ],
    };

    if (mode) {
      where.mode = mode;
    }
    if (status) {
      where.status = status;
    }

    const [matches, total] = await Promise.all([
      this.prismaService.match.findMany({
        where,
        select: {
          id: true,
          mode: true,
          status: true,
          winnerId: true,
          turnCount: true,
          startedAt: true,
          finishedAt: true,
        },
        orderBy: { startedAt: 'desc' },
        take: Math.min(limit, 100),
        skip: offset,
      }),
      this.prismaService.match.count({ where }),
    ]);

    return {
      matches,
      total,
      limit,
      offset,
    };
  }

  async updateAvatar(playerId: string, file: Express.Multer.File) {
    const player = await this.prismaService.player.findUnique({
      where: { id: playerId },
    });

    if (!player) {
      throw new NotFoundException('Player not found');
    }

    if (player.avatar) {
      await this.cloudinaryService.deleteImage(player.avatar);
    }

    const avatarUrl = await this.cloudinaryService.uploadImage(file);

    return this.prismaService.player.update({
      where: { id: playerId },
      data: { avatar: avatarUrl },
      select: {
        id: true,
        username: true,
        email: true,
        avatar: true,
        language: true,
        createdAt: true,
      },
    });
  }

  async updatePushToken(playerId: string, expoPushToken: string) {
    await this.prismaService.player.update({
      where: { id: playerId },
      data: { expoPushToken },
    });

    return { message: 'Push token updated' };
  }

  async getEloHistory(playerId: string, limit: number = 20) {
    return this.prismaService.eloHistory.findMany({
      where: { playerId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 50),
      include: {
        match: {
          select: {
            id: true,
            mode: true,
            winnerId: true,
            finishedAt: true,
          },
        },
      },
    });
  }
}

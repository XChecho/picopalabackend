import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class StatsService {
  constructor(private prismaService: PrismaService) {}

  async syncOfflineStats(
    playerId: string,
    stats: {
      wins: number;
      losses: number;
      draws: number;
      totalPicos: number;
      totalPalas: number;
    },
  ) {
    await this.prismaService.stats.update({
      where: { playerId },
      data: {
        wins: { increment: stats.wins },
        losses: { increment: stats.losses },
        draws: { increment: stats.draws },
        totalGames: { increment: stats.wins + stats.losses + stats.draws },
        totalPicos: { increment: stats.totalPicos },
        totalPalas: { increment: stats.totalPalas },
      },
    });

    return { message: 'Stats synced successfully' };
  }
}

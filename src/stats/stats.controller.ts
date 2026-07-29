import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { StatsService } from './stats.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('stats')
@UseGuards(JwtAuthGuard)
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Post('sync')
  async syncOfflineStats(
    @CurrentUser('id') playerId: string,
    @Body() stats: {
      wins: number;
      losses: number;
      draws: number;
      totalPicos: number;
      totalPalas: number;
    },
  ) {
    return this.statsService.syncOfflineStats(playerId, stats);
  }
}

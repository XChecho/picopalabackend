import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { StatsService } from "./stats.service";
import { SyncStatsDto } from "./dto/sync-stats.dto";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";

@Controller("stats")
@UseGuards(JwtAuthGuard)
export class StatsController {
  constructor(private readonly statsService: StatsService) {}

  @Post("sync")
  async syncOfflineStats(
    @CurrentUser("id") playerId: string,
    @Body() dto: SyncStatsDto,
  ) {
    return this.statsService.syncOfflineMatches(playerId, dto.matches);
  }
}

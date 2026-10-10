import { Module } from "@nestjs/common";
import { MatchService } from "./match.service";
import { MatchController } from "./match.controller";
import { MatchGateway } from "./match.gateway";
import { MatchSchedulerService } from "./match-scheduler.service";
import { GameModule } from "../game/game.module";
import { EloModule } from "../elo/elo.module";
import { StatsModule } from "../stats/stats.module";
import { AuthModule } from "../auth/auth.module";
import { RoomModule } from "../room/room.module";

@Module({
  imports: [GameModule, EloModule, StatsModule, AuthModule, RoomModule],
  controllers: [MatchController],
  providers: [MatchService, MatchGateway, MatchSchedulerService],
  exports: [MatchService],
})
export class MatchModule {}

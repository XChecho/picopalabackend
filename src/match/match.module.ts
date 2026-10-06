import { Module } from "@nestjs/common";
import { MatchService } from "./match.service";
import { MatchController } from "./match.controller";
import { MatchGateway } from "./match.gateway";
import { GameModule } from "../game/game.module";
import { EloModule } from "../elo/elo.module";
import { StatsModule } from "../stats/stats.module";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [GameModule, EloModule, StatsModule, AuthModule],
  controllers: [MatchController],
  providers: [MatchService, MatchGateway],
  exports: [MatchService],
})
export class MatchModule {}

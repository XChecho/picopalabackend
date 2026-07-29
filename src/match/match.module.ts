import { Module } from '@nestjs/common';
import { MatchService } from './match.service';
import { MatchController } from './match.controller';
import { MatchGateway } from './match.gateway';
import { GameModule } from '../game/game.module';

@Module({
  imports: [GameModule],
  controllers: [MatchController],
  providers: [MatchService, MatchGateway],
  exports: [MatchService],
})
export class MatchModule {}

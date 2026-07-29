import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { PlayerModule } from './player/player.module';
import { MatchModule } from './match/match.module';
import { RoomModule } from './room/room.module';
import { GameModule } from './game/game.module';
import { NotificationModule } from './notification/notification.module';
import { StatsModule } from './stats/stats.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    AuthModule,
    PlayerModule,
    MatchModule,
    RoomModule,
    GameModule,
    NotificationModule,
    StatsModule,
    PrismaModule,
    RedisModule,
  ],
})
export class AppModule {}

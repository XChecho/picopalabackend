import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { WebAuthController } from './web-auth.controller';
import { MobileAuthController } from './mobile-auth.controller';
import { JwtStrategy } from './strategies/jwt.strategy';
import { JwtRefreshStrategy } from './strategies/jwt-refresh.strategy';
import { WsJwtAuthGuard } from './guards/ws-jwt-auth.guard';

@Module({
  imports: [
    PassportModule,
    JwtModule.register({}),
  ],
  controllers: [WebAuthController, MobileAuthController],
  providers: [AuthService, JwtStrategy, JwtRefreshStrategy, WsJwtAuthGuard],
  exports: [AuthService, JwtModule, WsJwtAuthGuard],
})
export class AuthModule {}

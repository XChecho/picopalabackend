import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Platform } from '@prisma/client';
import { Request } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { AuthService } from './auth.service';
import { MobileLoginDto } from './dto/mobile-login.dto';
import { MobileRegisterDto } from './dto/mobile-register.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';

/** Mobile clients declare IOS|ANDROID (validated by the DTO); WEB is unreachable from here. */
@Controller('mobile/auth')
export class MobileAuthController {
  constructor(private readonly authService: AuthService) {}

  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @Post('register')
  async register(@Body() dto: MobileRegisterDto, @Req() req: Request) {
    return this.authService.register(
      dto,
      Platform[dto.platform],
      req.headers['user-agent'],
    );
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: MobileLoginDto, @Req() req: Request) {
    return this.authService.login(
      dto,
      Platform[dto.platform],
      req.headers['user-agent'],
    );
  }

  @Throttle({ default: { limit: 30, ttl: 60000 } })
  @Post('refresh')
  @UseGuards(JwtRefreshGuard)
  @HttpCode(HttpStatus.OK)
  async refresh(
    @CurrentUser('id') playerId: string,
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
  ) {
    return this.authService.refreshTokens(
      playerId,
      dto.refreshToken,
      req.headers['user-agent'],
    );
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async logout(
    @CurrentUser('id') playerId: string,
    @Body() dto: RefreshTokenDto,
  ) {
    return this.authService.logout(playerId, dto.refreshToken);
  }
}

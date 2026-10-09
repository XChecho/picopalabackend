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
import { CaptchaService } from '../captcha/captcha.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { getClientIp } from '../common/utils/client-ip.util';
import { AuthService } from './auth.service';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { WebLoginDto } from './dto/web-login.dto';
import { WebRegisterDto } from './dto/web-register.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';

@Controller('web/auth')
export class WebAuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly captchaService: CaptchaService,
  ) {}

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('register')
  async register(@Body() dto: WebRegisterDto, @Req() req: Request) {
    await this.captchaService.verify(dto.captchaToken, getClientIp(req));
    return this.authService.register(
      dto,
      Platform.WEB,
      req.headers['user-agent'],
    );
  }

  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: WebLoginDto, @Req() req: Request) {
    return this.authService.login(dto, Platform.WEB, req.headers['user-agent']);
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

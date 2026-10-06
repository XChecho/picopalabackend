import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { ContactDto } from './dto/contact.dto';
import { LeaderboardQueryDto } from './dto/leaderboard-query.dto';
import { UsernameParamDto } from './dto/username-param.dto';
import { WaitlistDto } from './dto/waitlist.dto';
import {
  IAppLinks,
  ILeaderboardEntry,
  IPublicPlayerProfile,
  IPublicStats,
  PublicService,
} from './public.service';

@Controller('public')
export class PublicController {
  constructor(private readonly publicService: PublicService) {}

  @Post('waitlist')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  async joinWaitlist(@Body() dto: WaitlistDto): Promise<{ subscribed: true }> {
    return this.publicService.joinWaitlist(dto);
  }

  @Post('contact')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async contact(@Body() dto: ContactDto, @Req() req: Request): Promise<{ received: true }> {
    return this.publicService.createContactMessage(dto, req.ip ?? '');
  }

  @Get('stats')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async stats(): Promise<IPublicStats> {
    return this.publicService.getStats();
  }

  @Get('app-links')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  appLinks(): IAppLinks {
    return this.publicService.getAppLinks();
  }

  @Get('leaderboard')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async leaderboard(@Query() query: LeaderboardQueryDto): Promise<ILeaderboardEntry[]> {
    return this.publicService.getLeaderboard(query.limit, query.offset);
  }

  @Get('players/:username')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  async player(@Param() params: UsernameParamDto): Promise<IPublicPlayerProfile> {
    return this.publicService.getPlayerProfile(params.username);
  }
}

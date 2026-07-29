import { Controller, Post, Get, Body, Param, UseGuards } from '@nestjs/common';
import { MatchService } from './match.service';
import { CreateMatchDto } from './dto/create-match.dto';
import { SubmitMoveDto } from './dto/submit-move.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('match')
@UseGuards(JwtAuthGuard)
export class MatchController {
  constructor(private readonly matchService: MatchService) {}

  @Post()
  async createMatch(
    @CurrentUser('id') playerId: string,
    @Body() createMatchDto: CreateMatchDto,
  ) {
    return this.matchService.createMatch(playerId, createMatchDto);
  }

  @Get(':id')
  async getMatch(
    @CurrentUser('id') playerId: string,
    @Param('id') matchId: string,
  ) {
    return this.matchService.getMatch(playerId, matchId);
  }

  @Post(':id/move')
  async submitMove(
    @CurrentUser('id') playerId: string,
    @Param('id') matchId: string,
    @Body() submitMoveDto: SubmitMoveDto,
  ) {
    return this.matchService.submitMove(playerId, matchId, submitMoveDto.guess);
  }
}

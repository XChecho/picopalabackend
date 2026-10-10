import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  ParseUUIDPipe,
  UseGuards,
} from "@nestjs/common";
import { EndReason } from "@prisma/client";
import { MatchService } from "./match.service";
import { CreateMatchDto } from "./dto/create-match.dto";
import { SubmitMoveDto } from "./dto/submit-move.dto";
import { SetSecretDto } from "./dto/set-secret.dto";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";

@Controller("match")
@UseGuards(JwtAuthGuard)
export class MatchController {
  constructor(private readonly matchService: MatchService) {}

  @Post()
  async createMatch(
    @CurrentUser("id") playerId: string,
    @Body() createMatchDto: CreateMatchDto,
  ) {
    return this.matchService.createMatch(playerId, createMatchDto);
  }

  // Declared before ":id" so "active" is not parsed as a UUID.
  @Get("active")
  async getActiveMatch(@CurrentUser("id") playerId: string) {
    // JSON body even when idle: an empty 200 breaks clients that parse JSON.
    return (await this.matchService.getActiveMatchByPlayer(playerId)) ?? {};
  }

  @Get(":id")
  async getMatch(
    @CurrentUser("id") playerId: string,
    @Param("id", ParseUUIDPipe) matchId: string,
  ) {
    return this.matchService.getMatch(playerId, matchId);
  }

  @Post(":id/secret")
  async setSecret(
    @CurrentUser("id") playerId: string,
    @Param("id", ParseUUIDPipe) matchId: string,
    @Body() setSecretDto: SetSecretDto,
  ) {
    return this.matchService.setSecret(playerId, matchId, setSecretDto);
  }

  @Post(":id/forfeit")
  async forfeit(
    @CurrentUser("id") playerId: string,
    @Param("id", ParseUUIDPipe) matchId: string,
  ) {
    return this.matchService.forfeitMatch(
      playerId,
      matchId,
      EndReason.RESIGNED,
    );
  }

  @Post(":id/rematch")
  async rematch(
    @CurrentUser("id") playerId: string,
    @Param("id", ParseUUIDPipe) matchId: string,
  ) {
    return this.matchService.requestRematch(playerId, matchId);
  }

  @Post(":id/move")
  async submitMove(
    @CurrentUser("id") playerId: string,
    @Param("id", ParseUUIDPipe) matchId: string,
    @Body() submitMoveDto: SubmitMoveDto,
  ) {
    return this.matchService.submitMove(playerId, matchId, submitMoveDto.guess);
  }
}

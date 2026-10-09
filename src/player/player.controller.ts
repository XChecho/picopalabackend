import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { PlayerService } from "./player.service";
import { UpdatePlayerDto } from "./dto/update-player.dto";
import { UpdatePushTokenDto } from "./dto/update-push-token.dto";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";

@Controller("player")
@UseGuards(JwtAuthGuard)
export class PlayerController {
  constructor(private readonly playerService: PlayerService) {}

  @Get("me")
  async getProfile(@CurrentUser("id") playerId: string) {
    return this.playerService.getProfile(playerId);
  }

  @Patch("me")
  async updateProfile(
    @CurrentUser("id") playerId: string,
    @Body() updatePlayerDto: UpdatePlayerDto,
  ) {
    return this.playerService.updateProfile(playerId, updatePlayerDto);
  }

  @Get("me/stats")
  async getStats(@CurrentUser("id") playerId: string) {
    return this.playerService.getStats(playerId);
  }

  @Get("me/matches")
  async getMatchHistory(
    @CurrentUser("id") playerId: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
    @Query("mode") mode?: string,
    @Query("status") status?: string,
  ) {
    return this.playerService.getMatchHistory(
      playerId,
      limit ? parseInt(limit, 10) : 20,
      offset ? parseInt(offset, 10) : 0,
      mode,
      status,
    );
  }

  @Post("me/avatar")
  @UseInterceptors(
    FileInterceptor("avatar", {
      limits: { fileSize: 5 * 1024 * 1024, files: 1 },
      fileFilter: (_req, file, cb) =>
        cb(
          null,
          ["image/jpeg", "image/png", "image/webp"].includes(file.mimetype),
        ),
    }),
  )
  async uploadAvatar(
    @CurrentUser("id") playerId: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    return this.playerService.updateAvatar(playerId, file);
  }

  @Patch("me/push-token")
  async updatePushToken(
    @CurrentUser("id") playerId: string,
    @Body() dto: UpdatePushTokenDto,
  ) {
    return this.playerService.updatePushToken(
      playerId,
      dto.expoPushToken,
      dto.platform,
    );
  }

  @Get("me/elo-history")
  async getEloHistory(
    @CurrentUser("id") playerId: string,
    @Query("limit") limit?: string,
  ) {
    return this.playerService.getEloHistory(
      playerId,
      limit ? parseInt(limit, 10) : 20,
    );
  }
}

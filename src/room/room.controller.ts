import { Controller, Post, Delete, Body, UseGuards } from "@nestjs/common";
import { RoomService } from "./room.service";
import { CreateRoomDto } from "./dto/create-room.dto";
import { JoinRoomDto } from "./dto/join-room.dto";
import { JwtAuthGuard } from "../auth/guards/jwt-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";

@Controller("room")
@UseGuards(JwtAuthGuard)
export class RoomController {
  constructor(private readonly roomService: RoomService) {}

  @Post("private")
  async createPrivateRoom(
    @CurrentUser("id") playerId: string,
    @Body() createRoomDto: CreateRoomDto,
  ) {
    return this.roomService.createPrivateRoom(playerId, createRoomDto.maxTurns);
  }

  @Post("private/join")
  async joinPrivateRoom(
    @CurrentUser("id") playerId: string,
    @Body() joinRoomDto: JoinRoomDto,
  ) {
    return this.roomService.joinPrivateRoom(playerId, joinRoomDto.code);
  }

  @Post("global/join")
  async joinGlobalQueue(
    @CurrentUser("id") playerId: string,
    @Body() createRoomDto: CreateRoomDto,
  ) {
    return this.roomService.joinGlobalQueue(playerId, createRoomDto.maxTurns);
  }

  @Delete("global/leave")
  async leaveGlobalQueue(@CurrentUser("id") playerId: string) {
    return this.roomService.leaveGlobalQueue(playerId);
  }
}

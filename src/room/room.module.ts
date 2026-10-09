import { Module } from "@nestjs/common";
import { RoomService } from "./room.service";
import { RoomController } from "./room.controller";
import { RoomGateway } from "./room.gateway";
import { GameModule } from "../game/game.module";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [GameModule, AuthModule],
  controllers: [RoomController],
  providers: [RoomService, RoomGateway],
  exports: [RoomService],
})
export class RoomModule {}

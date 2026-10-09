import { Module } from "@nestjs/common";
import { PlayerService } from "./player.service";
import { PlayerController } from "./player.controller";
import { CloudinaryModule } from "../cloudinary/cloudinary.module";

@Module({
  imports: [CloudinaryModule],
  controllers: [PlayerController],
  providers: [PlayerService],
  exports: [PlayerService],
})
export class PlayerModule {}

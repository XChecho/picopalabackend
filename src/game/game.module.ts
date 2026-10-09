import { Module } from "@nestjs/common";
import { GameService } from "./game.service";
import { AiService } from "./ai/ai.service";

@Module({
  providers: [GameService, AiService],
  exports: [GameService, AiService],
})
export class GameModule {}

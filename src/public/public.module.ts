import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { PublicController } from "./public.controller";
import { PublicService } from "./public.service";

@Module({
  controllers: [PublicController, HealthController],
  providers: [PublicService],
})
export class PublicModule {}

import { IsEnum, IsOptional, IsInt, Min, Max } from "class-validator";
import { Type } from "class-transformer";

export class CreateMatchDto {
  @IsEnum(["VERSUS_AI", "PRIVATE", "GLOBAL"])
  mode: "VERSUS_AI" | "PRIVATE" | "GLOBAL";

  @IsOptional()
  @IsEnum(["EASY", "MEDIUM", "HARD"])
  aiDifficulty?: "EASY" | "MEDIUM" | "HARD";

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  maxTurns?: number;
}

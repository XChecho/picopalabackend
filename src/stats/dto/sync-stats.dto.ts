import { Difficulty, MatchResult } from "@prisma/client";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

export const MAX_SYNC_MATCHES = 50;
export const MAX_TURNS_LIMIT = 20;

export class OfflineMatchDto {
  @IsUUID("4")
  clientMatchId: string;

  @IsEnum(Difficulty)
  aiDifficulty: Difficulty;

  @IsEnum(MatchResult)
  result: MatchResult;

  @IsInt()
  @Min(1)
  @Max(MAX_TURNS_LIMIT)
  attemptsUsed: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_TURNS_LIMIT)
  maxTurns?: number;

  @IsInt()
  @Min(0)
  @Max(4 * MAX_TURNS_LIMIT)
  totalPicos: number;

  @IsInt()
  @Min(0)
  @Max(4 * MAX_TURNS_LIMIT)
  totalPalas: number;

  @IsInt()
  @Min(0)
  @Max(86_400)
  durationSec: number;

  @IsOptional()
  @IsDateString()
  finishedAt?: string;
}

export class SyncStatsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SYNC_MATCHES)
  @ValidateNested({ each: true })
  @Type(() => OfflineMatchDto)
  matches: OfflineMatchDto[];
}

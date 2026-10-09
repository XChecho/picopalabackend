import { Difficulty, MatchResult } from "@prisma/client";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

export const MAX_SYNC_MATCHES = 50;
export const MAX_TURNS_LIMIT = 20;
// Two seats (player + AI), one move per turn each.
export const MAX_MOVES_PER_MATCH = 2 * MAX_TURNS_LIMIT;
const GUESS_PATTERN = /^[1-9]{4}$/;

export class OfflineMoveDto {
  // 1 = the human player, 2 = the AI.
  @IsIn([1, 2])
  seat: 1 | 2;

  @IsInt()
  @Min(1)
  @Max(MAX_TURNS_LIMIT)
  turnNumber: number;

  @Matches(GUESS_PATTERN)
  guess: string;

  @IsInt()
  @Min(0)
  @Max(4)
  picos: number;

  @IsInt()
  @Min(0)
  @Max(4)
  palas: number;

  @IsBoolean()
  isWin: boolean;
}

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

  // Optional so older clients that only sync aggregates keep working.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MOVES_PER_MATCH)
  @ValidateNested({ each: true })
  @Type(() => OfflineMoveDto)
  moves?: OfflineMoveDto[];

  @IsOptional()
  @Matches(GUESS_PATTERN)
  playerSecret?: string;

  @IsOptional()
  @Matches(GUESS_PATTERN)
  aiSecret?: string;
}

export class SyncStatsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SYNC_MATCHES)
  @ValidateNested({ each: true })
  @Type(() => OfflineMatchDto)
  matches: OfflineMatchDto[];
}

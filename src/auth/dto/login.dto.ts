import { Platform } from '@prisma/client';
import { IsString, MinLength, MaxLength, IsOptional, IsEnum } from 'class-validator';

export class LoginDto {
  @IsString()
  @MinLength(3)
  username: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;

  @IsOptional()
  @IsEnum(Platform)
  platform?: Platform;
}

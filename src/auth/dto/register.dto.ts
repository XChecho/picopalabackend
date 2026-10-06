import { Transform } from 'class-transformer';
import { Platform } from '@prisma/client';
import {
  IsString,
  IsEmail,
  MinLength,
  MaxLength,
  Matches,
  IsOptional,
  IsIn,
  IsEnum,
} from 'class-validator';

export class RegisterDto {
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  @Matches(/^[a-zA-Z0-9]+$/, { message: 'Username must be alphanumeric' })
  username: string;

  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password: string;

  @IsOptional()
  @IsString()
  @IsIn(['en', 'es', 'pt'])
  language?: string;

  @IsOptional()
  @IsEnum(Platform)
  platform?: Platform;
}

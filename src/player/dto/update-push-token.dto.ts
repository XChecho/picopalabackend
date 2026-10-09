import { Platform } from '@prisma/client';
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class UpdatePushTokenDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  expoPushToken: string;

  @IsOptional()
  @IsEnum(Platform)
  platform?: Platform;
}

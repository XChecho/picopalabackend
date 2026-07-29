import { IsString, IsOptional, IsIn, MaxLength, MinLength, Matches } from 'class-validator';

export class UpdatePlayerDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  @Matches(/^[a-zA-Z0-9]+$/, { message: 'Username must be alphanumeric' })
  username?: string;

  @IsOptional()
  @IsString()
  avatar?: string;

  @IsOptional()
  @IsString()
  @IsIn(['en', 'es'])
  language?: string;
}

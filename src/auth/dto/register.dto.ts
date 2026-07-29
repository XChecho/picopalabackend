import { IsString, IsEmail, MinLength, MaxLength, Matches, IsOptional, IsIn } from 'class-validator';

export class RegisterDto {
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  @Matches(/^[a-zA-Z0-9]+$/, { message: 'Username must be alphanumeric' })
  username: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;

  @IsOptional()
  @IsString()
  @IsIn(['en', 'es'])
  language?: string;
}

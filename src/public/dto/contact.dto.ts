import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

const collapseSpaces = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : value;

const cleanMessage = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string'
    ? value
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : value;

export class ContactDto {
  @Transform(collapseSpaces)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Transform(collapseSpaces)
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  subject!: string;

  @Transform(cleanMessage)
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  message!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  captchaToken!: string;
}

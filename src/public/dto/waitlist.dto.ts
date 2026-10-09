import { Transform } from "class-transformer";
import {
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";

export const WAITLIST_LOCALES = ["es", "en", "pt"] as const;
export type WaitlistLocale = (typeof WAITLIST_LOCALES)[number];

export class WaitlistDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsIn(WAITLIST_LOCALES)
  locale?: WaitlistLocale;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  source?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  captchaToken!: string;
}

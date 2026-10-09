import {
  IsString,
  IsOptional,
  IsIn,
  IsUrl,
  MaxLength,
  MinLength,
  Matches,
} from "class-validator";

export class UpdatePlayerDto {
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(20)
  @Matches(/^[a-zA-Z0-9]+$/, { message: "Username must be alphanumeric" })
  username?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  @IsUrl({
    protocols: ["https"],
    require_protocol: true,
    host_whitelist: ["res.cloudinary.com"],
  })
  avatar?: string;

  @IsOptional()
  @IsString()
  @IsIn(["en", "es", "pt"])
  language?: string;
}

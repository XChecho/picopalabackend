import { IsString, Matches, MaxLength } from "class-validator";

export class UsernameParamDto {
  @IsString()
  @MaxLength(24)
  @Matches(/^[A-Za-z0-9_.-]+$/)
  username!: string;
}

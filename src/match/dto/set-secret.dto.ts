import { IsBoolean, IsOptional, Matches } from "class-validator";

export class SetSecretDto {
  @IsOptional()
  @Matches(/^[1-9]{4}$/, {
    message: "Secret must be 4 unique digits between 1 and 9",
  })
  secret?: string;

  // true = let the server pick a random secret.
  @IsOptional()
  @IsBoolean()
  random?: boolean;
}

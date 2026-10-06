import { IsString, Length, Matches } from "class-validator";

export class SubmitMoveDto {
  @IsString()
  @Length(4, 4)
  @Matches(/^[1-9]{4}$/, {
    message: "Guess must be 4 unique digits between 1 and 9",
  })
  guess: string;
}

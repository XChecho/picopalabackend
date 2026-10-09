import { IsString, MaxLength, MinLength } from "class-validator";

/** Fields shared by every client. The platform is decided by the controller, never here. */
export abstract class LoginBaseDto {
  @IsString()
  @MinLength(3)
  username!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(72)
  password!: string;
}

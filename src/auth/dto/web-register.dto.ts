import { IsNotEmpty, IsString, MaxLength } from "class-validator";
import { RegisterBaseDto } from "./register-base.dto";

export class WebRegisterDto extends RegisterBaseDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  captchaToken!: string;
}

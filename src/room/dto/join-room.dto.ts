import { Transform } from "class-transformer";
import { IsString, Length } from "class-validator";

export class JoinRoomDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Length(6, 6)
  code: string;
}

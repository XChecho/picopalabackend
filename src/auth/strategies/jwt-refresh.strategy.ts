import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../prisma/prisma.service";
import { JwtPayload } from "../../common/interfaces/jwt-payload.interface";

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(
  Strategy,
  "jwt-refresh",
) {
  constructor(
    private configService: ConfigService,
    private prismaService: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>("JWT_REFRESH_SECRET"),
    });
  }

  async validate(payload: JwtPayload) {
    const player = await this.prismaService.player.findFirst({
      where: { id: payload.sub, deletedAt: null },
    });

    if (!player) {
      throw new UnauthorizedException("Player not found");
    }

    return {
      id: player.id,
      username: player.username,
    };
  }
}

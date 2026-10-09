import {
  Injectable,
  CanActivate,
  ExecutionContext,
  Logger,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { WsException } from "@nestjs/websockets";
import { Socket } from "socket.io";
import { PrismaService } from "../../prisma/prisma.service";

@Injectable()
export class WsJwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtAuthGuard.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client: Socket = context.switchToWs().getClient<Socket>();

    const token =
      client.handshake?.auth?.token ||
      client.handshake?.headers?.authorization?.replace("Bearer ", "");

    if (!token) {
      this.logger.warn(`Missing token from client ${client.id}`);
      throw new WsException("Missing authentication token");
    }

    try {
      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>("JWT_SECRET"),
      });
      // Soft-deleted players lose access even if their access token is still valid.
      const player = await this.prisma.player.findFirst({
        where: { id: payload.sub, deletedAt: null },
        select: { id: true },
      });
      if (!player) {
        throw new WsException("Invalid token");
      }
      client.data.user = payload;
      return true;
    } catch (err) {
      this.logger.warn(`Invalid token from client ${client.id}`);
      throw new WsException("Invalid token");
    }
  }
}

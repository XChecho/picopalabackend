import { Injectable, CanActivate, ExecutionContext, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { WsException } from '@nestjs/websockets';
import { Socket } from 'socket.io';

@Injectable()
export class WsJwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(WsJwtAuthGuard.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const client: Socket = context.switchToWs().getClient<Socket>();

    const token =
      client.handshake?.auth?.token ||
      client.handshake?.headers?.authorization?.replace('Bearer ', '');

    if (!token) {
      this.logger.warn(`Missing token from client ${client.id}`);
      throw new WsException('Missing authentication token');
    }

    try {
      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
      client.data.user = payload;
      return true;
    } catch (err) {
      this.logger.warn(`Invalid token from client ${client.id}`);
      throw new WsException('Invalid token');
    }
  }
}

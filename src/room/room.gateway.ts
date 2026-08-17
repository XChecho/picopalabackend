import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { RoomService } from './room.service';
import { WsJwtAuthGuard } from '../auth/guards/ws-jwt-auth.guard';

@WebSocketGateway({
  namespace: '/matchmaking',
  cors: {
    origin: process.env.CORS_ORIGIN || 'http://localhost:8081',
  },
})
@UseGuards(WsJwtAuthGuard)
export class RoomGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RoomGateway.name);

  constructor(
    private readonly roomService: RoomService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  handleConnection(client: Socket) {
    try {
      const token =
        client.handshake?.auth?.token ||
        client.handshake?.headers?.authorization?.replace('Bearer ', '');

      if (!token) {
        this.logger.warn(`Rejected connection ${client.id}: no token`);
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_SECRET'),
      });
      client.data.user = payload;

      this.logger.log(
        `Client connected to matchmaking: ${client.id} (player: ${payload.sub})`,
      );
    } catch (err) {
      this.logger.warn(`Rejected connection ${client.id}: invalid token`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected from matchmaking: ${client.id}`);
  }

  @SubscribeMessage('join_queue')
  async handleJoinQueue(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { maxTurns: number },
  ) {
    const playerId = client.data.user?.sub;
    if (!playerId) {
      return { event: 'error', data: { message: 'Not authenticated' } };
    }

    const result = await this.roomService.joinGlobalQueue(
      playerId,
      data.maxTurns,
    );

    if ('status' in result && result.status === 'queued') {
      return {
        event: 'queue_update',
        data: {
          position: result.queuePosition,
          estimatedWait: result.estimatedWait,
        },
      };
    }

    if ('match' in result) {
      this.server.to(client.id).emit('match_found', {
        matchId: result.match.id,
        roomId: result.room.id,
        opponent: {
          id: result.room.hostId,
          username: '',
        },
      });
    }

    return result;
  }

  @SubscribeMessage('leave_queue')
  async handleLeaveQueue(@ConnectedSocket() client: Socket) {
    const playerId = client.data.user?.sub;
    if (!playerId) {
      return { event: 'error', data: { message: 'Not authenticated' } };
    }

    await this.roomService.leaveGlobalQueue(playerId);
    return { event: 'left_queue' };
  }
}

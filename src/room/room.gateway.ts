import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { RoomService } from './room.service';

@WebSocketGateway({
  namespace: '/matchmaking',
  cors: {
    origin: '*',
  },
})
export class RoomGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(private roomService: RoomService) {}

  handleConnection(client: Socket) {
    console.log(`Client connected to matchmaking gateway: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected from matchmaking gateway: ${client.id}`);
  }

  @SubscribeMessage('join_queue')
  async handleJoinQueue(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { maxTurns: number; playerId: string },
  ) {
    const result = await this.roomService.joinGlobalQueue(data.playerId, data.maxTurns);

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
  async handleLeaveQueue(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { playerId: string },
  ) {
    await this.roomService.leaveGlobalQueue(data.playerId);
    return { event: 'left_queue' };
  }
}

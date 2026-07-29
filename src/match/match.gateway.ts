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
import { MatchService } from './match.service';

@WebSocketGateway({
  namespace: '/match',
  cors: {
    origin: '*',
  },
})
export class MatchGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  constructor(private matchService: MatchService) {}

  handleConnection(client: Socket) {
    console.log(`Client connected to match gateway: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`Client disconnected from match gateway: ${client.id}`);
  }

  @SubscribeMessage('join_match')
  handleJoinMatch(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { matchId: string },
  ) {
    client.join(data.matchId);
    return { event: 'joined_match', data: { matchId: data.matchId } };
  }

  @SubscribeMessage('leave_match')
  handleLeaveMatch(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { matchId: string },
  ) {
    client.leave(data.matchId);
    return { event: 'left_match', data: { matchId: data.matchId } };
  }

  @SubscribeMessage('submit_move')
  async handleSubmitMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { matchId: string; guess: string; playerId: string },
  ) {
    try {
      const result = await this.matchService.submitMove(
        data.playerId,
        data.matchId,
        data.guess,
      );

      this.server.to(data.matchId).emit('opponent_move', {
        playerId: data.playerId,
        guess: data.guess,
        palas: result.move.palas,
        picos: result.move.picos,
        isWin: result.move.isWin,
      });

      if ((result.matchStatus as string) === 'FINISHED') {
        this.server.to(data.matchId).emit('match_finished', {
          matchId: data.matchId,
          winnerId: result.move.isWin ? data.playerId : null,
          reason: result.move.isWin ? 'guessed' : 'max_turns',
        });
      }

      return { event: 'move_submitted', data: result };
    } catch (error) {
      return { event: 'error', data: { message: error.message } };
    }
  }
}

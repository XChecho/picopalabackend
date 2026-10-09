import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from "@nestjs/websockets";
import { Logger, OnModuleInit, UseGuards } from "@nestjs/common";
import { EndReason } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { Server, Socket } from "socket.io";
import { JwtService } from "@nestjs/jwt";
import { MatchEvent, MatchService } from "./match.service";
import { WsJwtAuthGuard } from "../auth/guards/ws-jwt-auth.guard";
import { corsOriginResolver } from "../common/utils/cors.util";

@WebSocketGateway({
  namespace: "/match",
  cors: {
    origin: corsOriginResolver,
  },
})
@UseGuards(WsJwtAuthGuard)
export class MatchGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MatchGateway.name);

  constructor(
    private readonly matchService: MatchService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    this.matchService.onMatchEvent((event) => this.broadcast(event));
  }

  private broadcast(event: MatchEvent): void {
    switch (event.type) {
      case "secret_set":
        this.server
          .to(event.matchId)
          .emit("opponent_ready", { playerId: event.playerId });
        break;
      case "started":
        this.server.to(event.matchId).emit("match_started", {
          matchId: event.matchId,
          currentSeat: event.currentSeat,
          turnDeadlineAt: event.turnDeadlineAt,
        });
        break;
      case "move":
        this.server.to(event.matchId).emit("opponent_move", {
          playerId: event.playerId,
          seat: event.seat,
          turnNumber: event.turnNumber,
          guess: event.guess,
          palas: event.palas,
          picos: event.picos,
          isWin: event.isWin,
          auto: event.auto,
          currentSeat: event.currentSeat,
          turnDeadlineAt: event.turnDeadlineAt,
        });
        break;
      case "finished":
        this.server.to(event.matchId).emit("match_finished", {
          matchId: event.matchId,
          winnerId: event.winnerId,
          reason: this.reasonLabel(event.endReason, event.aiGuessed),
          forfeitedBy: event.forfeitedBy,
        });
        break;
    }
  }

  handleConnection(client: Socket) {
    try {
      const token =
        client.handshake?.auth?.token ||
        client.handshake?.headers?.authorization?.replace("Bearer ", "");

      if (!token) {
        this.logger.warn(`Rejected connection ${client.id}: no token`);
        client.disconnect();
        return;
      }

      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>("JWT_SECRET"),
      });
      client.data.user = payload;

      this.logger.log(
        `Client connected: ${client.id} (player: ${payload.sub})`,
      );
    } catch (err) {
      this.logger.warn(`Rejected connection ${client.id}: invalid token`);
      client.disconnect();
    }
  }

  async handleDisconnect(client: Socket) {
    const userId = client.data.user?.sub;
    if (!userId) return;

    const matchId = client.data.currentMatchId;
    if (!matchId) {
      this.logger.log(`Client disconnected: ${client.id}`);
      return;
    }

    try {
      // A page reload opens the new socket before the old one closes.
      const sockets = await this.server.in(matchId).fetchSockets();
      const stillConnected = sockets.some(
        (s) => s.id !== client.id && s.data.user?.sub === userId,
      );
      if (stillConnected) return;

      this.server.to(matchId).emit("opponent_disconnected", {
        playerId: userId,
      });
      // Persisted: MatchSchedulerService forfeits after the grace period,
      // even if this process restarts in between.
      await this.matchService.markDisconnected(userId, matchId);

      // The replacement socket may have joined while we were writing.
      const after = await this.server.in(matchId).fetchSockets();
      if (
        after.some((s) => s.id !== client.id && s.data.user?.sub === userId)
      ) {
        await this.matchService.markConnected(userId, matchId);
      }
    } catch (error) {
      this.logger.error(
        `Error handling disconnect: ${(error as Error).message}`,
      );
    }

    this.logger.log(
      `Client disconnected: ${client.id} (player: ${userId}, match: ${matchId})`,
    );
  }

  @SubscribeMessage("join_match")
  async handleJoinMatch(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { matchId: string },
  ) {
    const playerId = client.data.user?.sub;
    if (
      !playerId ||
      !(await this.matchService.isParticipant(playerId, data.matchId))
    ) {
      return {
        event: "error",
        data: { message: "Not authorized to join this match" },
      };
    }
    client.join(data.matchId);
    client.data.currentMatchId = data.matchId;
    if (await this.matchService.markConnected(playerId, data.matchId)) {
      this.server.to(data.matchId).emit("opponent_reconnected", { playerId });
    }
    return { event: "joined_match", data: { matchId: data.matchId } };
  }

  @SubscribeMessage("leave_match")
  handleLeaveMatch(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { matchId: string },
  ) {
    client.leave(data.matchId);
    client.data.currentMatchId = undefined;
    return { event: "left_match", data: { matchId: data.matchId } };
  }

  @SubscribeMessage("submit_move")
  async handleSubmitMove(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { matchId: string; guess: string },
  ) {
    try {
      const playerId = client.data.user?.sub;
      if (!playerId) {
        return { event: "error", data: { message: "Not authenticated" } };
      }

      const result = await this.matchService.submitMove(
        playerId,
        data.matchId,
        data.guess,
      );

      return { event: "move_submitted", data: result };
    } catch (error) {
      return { event: "error", data: { message: (error as Error).message } };
    }
  }

  private reasonLabel(reason: EndReason | null, aiGuessed: boolean): string {
    switch (reason) {
      case EndReason.GUESSED:
        return aiGuessed ? "ai_guessed" : "guessed";
      case EndReason.MAX_TURNS:
        return "max_turns";
      case EndReason.ABANDONED:
        return "forfeit";
      case EndReason.RESIGNED:
        return "resigned";
      case EndReason.TIMEOUT:
        return "timeout";
      default:
        return "max_turns";
    }
  }
}

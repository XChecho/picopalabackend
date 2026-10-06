import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayConnection,
  OnGatewayDisconnect,
  ConnectedSocket,
  MessageBody,
} from "@nestjs/websockets";
import { Logger, UseGuards } from "@nestjs/common";
import { EndReason } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { Server, Socket } from "socket.io";
import { JwtService } from "@nestjs/jwt";
import { MatchService } from "./match.service";
import { WsJwtAuthGuard } from "../auth/guards/ws-jwt-auth.guard";
import { corsOriginResolver } from "../common/utils/cors.util";

interface DisconnectTimer {
  timeout: NodeJS.Timeout;
  matchId: string;
}

@WebSocketGateway({
  namespace: "/match",
  cors: {
    origin: corsOriginResolver,
  },
})
@UseGuards(WsJwtAuthGuard)
export class MatchGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(MatchGateway.name);
  private readonly disconnectTimers = new Map<string, DisconnectTimer>();

  constructor(
    private readonly matchService: MatchService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

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

      const timer = this.disconnectTimers.get(payload.sub);
      if (timer) {
        clearTimeout(timer.timeout);
        this.disconnectTimers.delete(payload.sub);

        client.data.currentMatchId = timer.matchId;
        client.join(timer.matchId);
        this.server.to(timer.matchId).emit("opponent_reconnected", {
          playerId: payload.sub,
        });

        this.logger.log(
          `Reconnected player ${payload.sub} to match ${timer.matchId}`,
        );
      }

      this.logger.log(
        `Client connected: ${client.id} (player: ${payload.sub})`,
      );
    } catch (err) {
      this.logger.warn(`Rejected connection ${client.id}: invalid token`);
      client.disconnect();
    }
  }

  handleDisconnect(client: Socket) {
    const userId = client.data.user?.sub;
    if (!userId) return;

    const matchId = client.data.currentMatchId;
    if (!matchId) {
      this.logger.log(`Client disconnected: ${client.id}`);
      return;
    }

    this.server.to(matchId).emit("opponent_disconnected", {
      playerId: userId,
    });

    const timeout = setTimeout(async () => {
      this.disconnectTimers.delete(userId);
      try {
        const updatedMatch = await this.matchService.forfeitMatch(
          userId,
          matchId,
        );
        this.server.to(matchId).emit("match_finished", {
          matchId,
          winnerId: updatedMatch.winnerId,
          reason: this.reasonLabel(updatedMatch.endReason, false),
          forfeitedBy: userId,
        });
      } catch (error) {
        this.logger.error(
          `Error forfeiting match: ${(error as Error).message}`,
        );
      }
    }, 60000);

    this.disconnectTimers.set(userId, { timeout, matchId });

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

      this.server.to(data.matchId).emit("opponent_move", {
        playerId,
        guess: data.guess,
        palas: result.move.palas,
        picos: result.move.picos,
        isWin: result.move.isWin,
      });

      if (result.matchStatus === "FINISHED") {
        this.server.to(data.matchId).emit("match_finished", {
          matchId: data.matchId,
          winnerId: result.winnerId,
          reason: this.reasonLabel(
            result.endReason,
            result.aiMove?.isWin === true,
          ),
        });
      }

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

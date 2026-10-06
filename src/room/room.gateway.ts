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
import { ConfigService } from "@nestjs/config";
import { Server, Socket } from "socket.io";
import { JwtService } from "@nestjs/jwt";
import { IMatchFoundEvent, RoomService } from "./room.service";
import { WsJwtAuthGuard } from "../auth/guards/ws-jwt-auth.guard";
import { corsOriginResolver } from "../common/utils/cors.util";

@WebSocketGateway({
  namespace: "/matchmaking",
  cors: {
    origin: corsOriginResolver,
  },
})
@UseGuards(WsJwtAuthGuard)
export class RoomGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(RoomGateway.name);

  constructor(
    private readonly roomService: RoomService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    this.roomService.onMatchFound((event) => this.broadcastMatchFound(event));
  }

  private broadcastMatchFound(event: IMatchFoundEvent): void {
    for (const player of event.players) {
      const opponent = event.players.find((p) => p.id !== player.id);
      this.server.to(`player:${player.id}`).emit("match_found", {
        matchId: event.matchId,
        roomId: event.roomId,
        opponent: opponent
          ? { id: opponent.id, username: opponent.username }
          : null,
      });
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
      client.join(`player:${payload.sub}`);

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

  @SubscribeMessage("join_queue")
  async handleJoinQueue(
    @ConnectedSocket() client: Socket,
    @MessageBody() data: { maxTurns: number },
  ) {
    const playerId = client.data.user?.sub;
    if (!playerId) {
      return { event: "error", data: { message: "Not authenticated" } };
    }

    try {
      const result = await this.roomService.joinGlobalQueue(
        playerId,
        data?.maxTurns,
      );

      if (result.status === "queued") {
        return {
          event: "queue_update",
          data: {
            position: result.queuePosition,
            estimatedWait: result.estimatedWait,
          },
        };
      }

      // match_found is pushed to both players by the onMatchFound listener.
      return result;
    } catch (error) {
      return { event: "error", data: { message: (error as Error).message } };
    }
  }

  @SubscribeMessage("leave_queue")
  async handleLeaveQueue(@ConnectedSocket() client: Socket) {
    const playerId = client.data.user?.sub;
    if (!playerId) {
      return { event: "error", data: { message: "Not authenticated" } };
    }

    try {
      await this.roomService.leaveGlobalQueue(playerId);
      return { event: "left_queue" };
    } catch (error) {
      return { event: "error", data: { message: (error as Error).message } };
    }
  }
}

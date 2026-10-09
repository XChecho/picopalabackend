import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

@Injectable()
export class NotificationService {
  constructor(private configService: ConfigService) {}

  async sendPushNotification(
    expoPushToken: string,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ) {
    try {
      const response = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          to: expoPushToken,
          title,
          body,
          data,
        }),
      });

      const result = await response.json();
      return result;
    } catch (error) {
      console.error("Failed to send push notification:", error);
      return null;
    }
  }

  async notifyOpponentMove(
    expoPushToken: string,
    matchId: string,
    opponentUsername: string,
  ) {
    return this.sendPushNotification(
      expoPushToken,
      "Opponent moved!",
      `${opponentUsername} has made their move. It's your turn!`,
      { matchId, type: "OPPONENT_MOVE" },
    );
  }

  async notifyMatchFound(
    expoPushToken: string,
    matchId: string,
    opponentUsername: string,
  ) {
    return this.sendPushNotification(
      expoPushToken,
      "Match found!",
      `Your match with ${opponentUsername} is ready.`,
      { matchId, type: "MATCH_FOUND" },
    );
  }

  async notifyRoomInvite(
    expoPushToken: string,
    roomId: string,
    code: string,
    hostUsername: string,
  ) {
    return this.sendPushNotification(
      expoPushToken,
      "Room invitation",
      `${hostUsername} invited you to play! Code: ${code}`,
      { roomId, code, type: "ROOM_INVITE" },
    );
  }
}

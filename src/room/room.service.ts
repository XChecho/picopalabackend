import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GameService } from '../game/game.service';

@Injectable()
export class RoomService {
  constructor(
    private prismaService: PrismaService,
    private gameService: GameService,
  ) {}

  async createPrivateRoom(hostId: string, maxTurns: number = 10) {
    const code = this.generateRoomCode();

    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1);

    const room = await this.prismaService.room.create({
      data: {
        code,
        type: 'PRIVATE',
        hostId,
        maxTurns,
        status: 'WAITING',
        expiresAt,
      },
      select: {
        id: true,
        code: true,
        type: true,
        hostId: true,
        maxTurns: true,
        status: true,
        expiresAt: true,
        createdAt: true,
      },
    });

    return room;
  }

  async joinPrivateRoom(guestId: string, code: string) {
    const room = await this.prismaService.room.findUnique({
      where: { code },
      include: {
        match: true,
      },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    if (room.expiresAt < new Date()) {
      throw new ConflictException('Room has expired');
    }

    if (room.guestId) {
      throw new ConflictException('Room is already full');
    }

    if (room.hostId === guestId) {
      throw new BadRequestException('Cannot join your own room');
    }

    const hostNumber = this.gameService.generateSecretNumber();
    const guestNumber = this.gameService.generateSecretNumber();

    const match = await this.prismaService.match.create({
      data: {
        mode: room.type === 'GLOBAL' ? 'GLOBAL' : 'PRIVATE',
        status: 'PLAYING',
        player1Id: room.hostId,
        player2Id: guestId,
        player1Number: hostNumber,
        player2Number: guestNumber,
        maxTurns: room.maxTurns,
        roomId: room.id,
      },
      select: {
        id: true,
        mode: true,
        status: true,
        player1Id: true,
        player2Id: true,
        currentTurn: true,
        maxTurns: true,
      },
    });

    await this.prismaService.room.update({
      where: { id: room.id },
      data: {
        guestId,
        matchId: match.id,
        status: 'IN_GAME',
      },
    });

    return {
      room: {
        id: room.id,
        code: room.code,
        hostId: room.hostId,
        guestId,
        status: 'IN_GAME',
        matchId: match.id,
      },
      match,
    };
  }

  async joinGlobalQueue(playerId: string, maxTurns: number = 10) {
    const player = await this.prismaService.player.findUnique({
      where: { id: playerId },
      select: { elo: true },
    });

    if (!player) {
      throw new NotFoundException('Player not found');
    }

    const initialEloRange = 200;
    const existingRoom = await this.prismaService.room.findFirst({
      where: {
        type: 'GLOBAL',
        status: 'WAITING',
        guestId: null,
        hostId: { not: playerId },
        expiresAt: { gt: new Date() },
        host: {
          elo: {
            gte: player.elo - initialEloRange,
            lte: player.elo + initialEloRange,
          },
        },
      },
      include: {
        host: { select: { elo: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (existingRoom) {
      return this.joinPrivateRoom(playerId, existingRoom.code);
    }

    const code = this.generateRoomCode();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 1);

    await this.prismaService.room.create({
      data: {
        code,
        type: 'GLOBAL',
        hostId: playerId,
        maxTurns,
        status: 'WAITING',
        expiresAt,
      },
    });

    return {
      status: 'queued',
      queuePosition: 1,
      estimatedWait: 30,
    };
  }

  async leaveGlobalQueue(playerId: string) {
    await this.prismaService.room.deleteMany({
      where: {
        type: 'GLOBAL',
        hostId: playerId,
        status: 'WAITING',
        guestId: null,
      },
    });

    return { message: 'Left matchmaking queue' };
  }

  private generateRoomCode(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }
}

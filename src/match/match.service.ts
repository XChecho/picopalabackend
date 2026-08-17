import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GameService } from '../game/game.service';
import { AiService } from '../game/ai/ai.service';
import { EloService } from '../elo/elo.service';
import { CreateMatchDto } from './dto/create-match.dto';

const AI_PLAYER_ID = 'ai-player';

@Injectable()
export class MatchService {
  constructor(
    private prismaService: PrismaService,
    private gameService: GameService,
    private aiService: AiService,
    private eloService: EloService,
  ) {}

  async createMatch(playerId: string, createMatchDto: CreateMatchDto) {
    if (createMatchDto.mode !== 'VERSUS_AI') {
      throw new BadRequestException('POST /match is only for VERSUS_AI mode. Use Room module for PRIVATE/GLOBAL.');
    }

    const player1Number = this.gameService.generateSecretNumber();
    const player2Number = this.gameService.generateSecretNumber();

    const match = await this.prismaService.match.create({
      data: {
        mode: createMatchDto.mode,
        status: 'PLAYING',
        player1Id: playerId,
        player1Number,
        player2Number,
        maxTurns: createMatchDto.maxTurns || 10,
        aiDifficulty: createMatchDto.aiDifficulty,
      },
      select: {
        id: true,
        mode: true,
        status: true,
        player1Id: true,
        player1Number: true,
        currentTurn: true,
        turnCount: true,
        maxTurns: true,
        aiDifficulty: true,
        startedAt: true,
        createdAt: true,
      },
    });

    return match;
  }

  async getMatch(playerId: string, matchId: string) {
    const match = await this.prismaService.match.findUnique({
      where: { id: matchId },
      include: {
        moves: {
          orderBy: { turnNumber: 'asc' },
        },
      },
    });

    if (!match) {
      throw new NotFoundException('Match not found');
    }

    if (match.player1Id !== playerId && match.player2Id !== playerId) {
      throw new ForbiddenException('Not authorized to view this match');
    }

    const { player1Number, player2Number, ...matchData } = match;

    return {
      ...matchData,
      player1Number: match.player1Id === playerId ? player1Number : undefined,
      player2Number: match.player2Id === playerId ? player2Number : undefined,
    };
  }

  async forfeitMatch(playerId: string, matchId: string) {
    const match = await this.prismaService.match.findUnique({
      where: { id: matchId },
    });

    if (!match) {
      throw new NotFoundException('Match not found');
    }

    if (match.status === 'FINISHED') {
      return match;
    }

    if (match.player1Id !== playerId && match.player2Id !== playerId) {
      throw new ForbiddenException('Not a participant in this match');
    }

    const opponentId =
      match.player1Id === playerId ? match.player2Id : match.player1Id;

    const updatedMatch = await this.prismaService.match.update({
      where: { id: matchId },
      data: {
        status: 'FINISHED',
        winnerId: opponentId ?? null,
        finishedAt: new Date(),
      },
    });

    await this.prismaService.stats.update({
      where: { playerId },
      data: {
        losses: { increment: 1 },
        totalGames: { increment: 1 },
      },
    });

    if (opponentId) {
      await this.prismaService.stats.update({
        where: { playerId: opponentId },
        data: {
          wins: { increment: 1 },
          totalGames: { increment: 1 },
        },
      });

      if (match.mode === 'GLOBAL') {
        await this.eloService.updatePlayerElo(opponentId, playerId, matchId);
      }
    }

    return updatedMatch;
  }

  async getActiveMatchByPlayer(playerId: string) {
    const match = await this.prismaService.match.findFirst({
      where: {
        status: 'PLAYING',
        OR: [{ player1Id: playerId }, { player2Id: playerId }],
      },
      orderBy: { createdAt: 'desc' },
    });

    return match;
  }

  async submitMove(playerId: string, matchId: string, guess: string) {
    const validation = this.gameService.validateGuess(guess);
    if (!validation.valid) {
      throw new BadRequestException(validation.error);
    }

    const match = await this.prismaService.match.findUnique({
      where: { id: matchId },
      include: {
        moves: {
          orderBy: { turnNumber: 'asc' },
        },
      },
    });

    if (!match) {
      throw new NotFoundException('Match not found');
    }

    if (match.status === 'FINISHED') {
      throw new ConflictException('Match already finished');
    }

    if (match.player1Id !== playerId && match.player2Id !== playerId) {
      throw new ForbiddenException('Not authorized to play in this match');
    }

    const isPlayer1 = match.player1Id === playerId;
    const isPlayerTurn = isPlayer1
      ? match.currentTurn % 2 === 1
      : match.currentTurn % 2 === 0;

    if (!isPlayerTurn) {
      throw new ForbiddenException('Not your turn');
    }

    const secretNumber = isPlayer1 ? match.player2Number : match.player1Number;

    if (!secretNumber) {
      throw new BadRequestException('Match is not ready to play');
    }

    const feedback = this.gameService.calculateFeedback(guess, secretNumber);

    const move = await this.prismaService.move.create({
      data: {
        matchId,
        playerId,
        turnNumber: match.currentTurn,
        guess,
        palas: feedback.palas,
        picos: feedback.picos,
        isWin: feedback.isWin,
      },
    });

    let matchStatus: 'WAITING' | 'PLAYING' | 'FINISHED' = match.status;
    let winnerId = match.winnerId;
    let finishedAt = match.finishedAt;

    if (feedback.isWin) {
      matchStatus = 'FINISHED';
      winnerId = playerId;
      finishedAt = new Date();

      await this.prismaService.stats.update({
        where: { playerId },
        data: {
          wins: { increment: 1 },
          totalGames: { increment: 1 },
        },
      });

      const opponentId = isPlayer1 ? match.player2Id : match.player1Id;
      if (opponentId) {
        await this.prismaService.stats.update({
          where: { playerId: opponentId },
          data: {
            losses: { increment: 1 },
            totalGames: { increment: 1 },
          },
        });
      }
    } else {
      const newTurnCount = match.turnCount + 1;
      if (newTurnCount >= match.maxTurns * 2) {
        matchStatus = 'FINISHED';
        finishedAt = new Date();

        const playerIds = [match.player1Id];
        if (match.player2Id) {
          playerIds.push(match.player2Id);
        }

        await this.prismaService.stats.updateMany({
          where: {
            playerId: { in: playerIds },
          },
          data: {
            draws: { increment: 1 },
            totalGames: { increment: 1 },
          },
        });
      }
    }

    await this.prismaService.match.update({
      where: { id: matchId },
      data: {
        currentTurn: match.currentTurn + 1,
        turnCount: match.turnCount + 1,
        status: matchStatus,
        winnerId,
        finishedAt,
      },
    });

    if (match.mode === 'GLOBAL' && matchStatus === 'FINISHED' && winnerId) {
      const loserId = isPlayer1 ? match.player2Id : match.player1Id;
      if (loserId) {
        await this.eloService.updatePlayerElo(winnerId, loserId, matchId);
      }
    }

    let aiMove = null;

    if (match.mode === 'VERSUS_AI' && (matchStatus as string) !== 'FINISHED') {
      const opponentId = isPlayer1 ? match.player2Id : match.player1Id;
      if (!opponentId) {
        const aiGuess = this.generateAiMove(match.aiDifficulty!, [...match.moves, move]);
        const aiSecret = match.player1Number;
        const aiFeedback = this.gameService.calculateFeedback(aiGuess, aiSecret);

        aiMove = await this.prismaService.move.create({
          data: {
            matchId,
            playerId: AI_PLAYER_ID,
            turnNumber: match.currentTurn + 1,
            guess: aiGuess,
            palas: aiFeedback.palas,
            picos: aiFeedback.picos,
            isWin: aiFeedback.isWin,
          },
        });

        if (aiFeedback.isWin) {
          matchStatus = 'FINISHED';
          await this.prismaService.match.update({
            where: { id: matchId },
            data: {
              currentTurn: match.currentTurn + 2,
              turnCount: match.turnCount + 2,
              status: 'FINISHED',
              winnerId: AI_PLAYER_ID,
              finishedAt: new Date(),
            },
          });

          await this.prismaService.stats.update({
            where: { playerId },
            data: {
              losses: { increment: 1 },
              totalGames: { increment: 1 },
            },
          });
        } else {
          await this.prismaService.match.update({
            where: { id: matchId },
            data: {
              currentTurn: match.currentTurn + 2,
              turnCount: match.turnCount + 2,
            },
          });
        }
      }
    }

    return {
      move,
      matchStatus,
      nextTurn: match.currentTurn + (aiMove ? 2 : 1),
      aiMove: aiMove
        ? {
            guess: aiMove.guess,
            palas: aiMove.palas,
            picos: aiMove.picos,
            isWin: aiMove.isWin,
          }
        : undefined,
    };
  }

  private generateAiMove(
    difficulty: string,
    moves: Array<{ guess: string; palas: number; picos: number }>,
  ): string {
    const usedGuesses = moves.map((m) => m.guess);

    switch (difficulty) {
      case 'EASY':
        return this.aiService.easyMove(usedGuesses);
      case 'MEDIUM':
        return this.aiService.mediumMove(moves);
      case 'HARD':
        return this.aiService.hardMove(moves);
      default:
        return this.aiService.easyMove(usedGuesses);
    }
  }
}

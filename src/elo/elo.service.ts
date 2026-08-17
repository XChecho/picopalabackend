import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class EloService {
  private readonly K_FACTOR = 32;

  constructor(private prismaService: PrismaService) {}

  calculateEloChange(winnerElo: number, loserElo: number, k: number = this.K_FACTOR) {
    const expectedWinner = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));
    const expectedLoser = 1 - expectedWinner;

    const winnerChange = Math.round(k * (1 - expectedWinner));
    const loserChange = Math.round(k * (0 - expectedLoser));

    return { winnerChange, loserChange };
  }

  calculateTrophies(elo: number): number {
    return Math.floor(elo / 10);
  }

  calculateRank(elo: number): string {
    if (elo >= 2500) return 'DIAMANTE';
    if (elo >= 2000) return 'PLATINO';
    if (elo >= 1500) return 'ORO';
    if (elo >= 1000) return 'PLATA';
    return 'BRONCE';
  }

  async updatePlayerElo(winnerId: string, loserId: string, matchId: string): Promise<void> {
    await this.prismaService.$transaction(async (tx) => {
      const winner = await tx.player.findUnique({ where: { id: winnerId } });
      const loser = await tx.player.findUnique({ where: { id: loserId } });

      if (!winner) {
        throw new NotFoundException(`Winner player not found: ${winnerId}`);
      }
      if (!loser) {
        throw new NotFoundException(`Loser player not found: ${loserId}`);
      }

      const { winnerChange, loserChange } = this.calculateEloChange(winner.elo, loser.elo);

      const newWinnerElo = winner.elo + winnerChange;
      const newLoserElo = loser.elo + loserChange;

      const newWinnerTrophies = this.calculateTrophies(newWinnerElo);
      const newLoserTrophies = this.calculateTrophies(newLoserElo);

      const newWinnerRank = this.calculateRank(newWinnerElo);
      const newLoserRank = this.calculateRank(newLoserElo);

      await tx.player.update({
        where: { id: winnerId },
        data: {
          elo: newWinnerElo,
          trophies: newWinnerTrophies,
          rank: newWinnerRank,
        },
      });

      await tx.player.update({
        where: { id: loserId },
        data: {
          elo: newLoserElo,
          trophies: newLoserTrophies,
          rank: newLoserRank,
        },
      });

      await tx.eloHistory.createMany({
        data: [
          {
            playerId: winnerId,
            matchId,
            oldElo: winner.elo,
            newElo: newWinnerElo,
            oldTrophies: this.calculateTrophies(winner.elo),
            newTrophies: newWinnerTrophies,
            oldRank: this.calculateRank(winner.elo),
            newRank: newWinnerRank,
          },
          {
            playerId: loserId,
            matchId,
            oldElo: loser.elo,
            newElo: newLoserElo,
            oldTrophies: this.calculateTrophies(loser.elo),
            newTrophies: newLoserTrophies,
            oldRank: this.calculateRank(loser.elo),
            newRank: newLoserRank,
          },
        ],
      });
    });
  }
}

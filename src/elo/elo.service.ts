import { Injectable } from "@nestjs/common";
import { Rank } from "@prisma/client";

export interface IEloSide {
  elo: number;
  /** 1 = win, 0.5 = draw, 0 = loss */
  score: 0 | 0.5 | 1;
}

export interface IEloOutcome {
  eloBefore: number;
  eloAfter: number;
  rankBefore: Rank;
  rankAfter: Rank;
}

@Injectable()
export class EloService {
  private readonly K_FACTOR = 32;

  /** Standard Elo delta for side A against side B. */
  calculateDelta(
    ratingA: number,
    ratingB: number,
    scoreA: number,
    k: number = this.K_FACTOR,
  ): number {
    const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
    return Math.round(k * (scoreA - expectedA));
  }

  calculateRank(elo: number): Rank {
    if (elo >= 2500) return Rank.DIAMANTE;
    if (elo >= 2000) return Rank.PLATINO;
    if (elo >= 1500) return Rank.ORO;
    if (elo >= 1000) return Rank.PLATA;
    return Rank.BRONCE;
  }

  /**
   * Pure computation of the new ratings for a head-to-head match.
   * Persistence is done by MatchService inside the match-finish transaction.
   */
  computeOutcome(a: IEloSide, b: IEloSide): { a: IEloOutcome; b: IEloOutcome } {
    const deltaA = this.calculateDelta(a.elo, b.elo, a.score);
    const deltaB = this.calculateDelta(b.elo, a.elo, b.score);

    const eloAfterA = Math.max(0, a.elo + deltaA);
    const eloAfterB = Math.max(0, b.elo + deltaB);

    return {
      a: {
        eloBefore: a.elo,
        eloAfter: eloAfterA,
        rankBefore: this.calculateRank(a.elo),
        rankAfter: this.calculateRank(eloAfterA),
      },
      b: {
        eloBefore: b.elo,
        eloAfter: eloAfterB,
        rankBefore: this.calculateRank(b.elo),
        rankAfter: this.calculateRank(eloAfterB),
      },
    };
  }
}

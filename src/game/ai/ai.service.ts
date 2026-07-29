import { Injectable } from '@nestjs/common';
import { GameService } from '../game.service';

@Injectable()
export class AiService {
  constructor(private gameService: GameService) {}

  easyMove(usedGuesses: string[]): string {
    let guess: string;
    let attempts = 0;
    do {
      guess = this.gameService.generateSecretNumber();
      attempts++;
    } while (usedGuesses.includes(guess) && attempts < 100);
    return guess;
  }

  mediumMove(moves: Array<{ guess: string; palas: number; picos: number }>): string {
    const possibilities = this.getAllPossibilities();
    const filtered = this.filterByFeedback(possibilities, moves);
    return filtered[Math.floor(Math.random() * filtered.length)];
  }

  hardMove(moves: Array<{ guess: string; palas: number; picos: number }>): string {
    const possibilities = this.getAllPossibilities();
    const filtered = this.filterByFeedback(possibilities, moves);

    if (filtered.length === 0) {
      return this.gameService.generateSecretNumber();
    }

    if (filtered.length === 1) {
      return filtered[0];
    }

    let bestGuess = filtered[0];
    let minMaxRemaining = Infinity;

    for (const guess of filtered.slice(0, 50)) {
      let maxRemaining = 0;
      for (const secret of filtered) {
        const feedback = this.gameService.calculateFeedback(guess, secret);
        const remaining = filtered.filter((s) => {
          const f = this.gameService.calculateFeedback(guess, s);
          return f.palas === feedback.palas && f.picos === feedback.picos;
        }).length;
        maxRemaining = Math.max(maxRemaining, remaining);
      }
      if (maxRemaining < minMaxRemaining) {
        minMaxRemaining = maxRemaining;
        bestGuess = guess;
      }
    }

    return bestGuess;
  }

  private getAllPossibilities(): string[] {
    const possibilities: string[] = [];
    const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9];

    for (const a of digits) {
      for (const b of digits) {
        if (b === a) continue;
        for (const c of digits) {
          if (c === a || c === b) continue;
          for (const d of digits) {
            if (d === a || d === b || d === c) continue;
            possibilities.push(`${a}${b}${c}${d}`);
          }
        }
      }
    }

    return possibilities;
  }

  private filterByFeedback(
    possibilities: string[],
    moves: Array<{ guess: string; palas: number; picos: number }>,
  ): string[] {
    return possibilities.filter((secret) =>
      moves.every((move) => {
        const feedback = this.gameService.calculateFeedback(move.guess, secret);
        return feedback.palas === move.palas && feedback.picos === move.picos;
      }),
    );
  }
}

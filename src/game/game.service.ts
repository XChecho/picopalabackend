import { Injectable } from '@nestjs/common';

export interface MoveFeedback {
  palas: number;
  picos: number;
  isWin: boolean;
}

@Injectable()
export class GameService {
  generateSecretNumber(): string {
    const digits = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const selected: number[] = [];

    for (let i = 0; i < 4; i++) {
      const randomIndex = Math.floor(Math.random() * digits.length);
      selected.push(digits[randomIndex]);
      digits.splice(randomIndex, 1);
    }

    return selected.join('');
  }

  calculateFeedback(guess: string, secret: string): MoveFeedback {
    let palas = 0;
    let picos = 0;

    for (let i = 0; i < 4; i++) {
      if (guess[i] === secret[i]) {
        palas++;
      } else if (secret.includes(guess[i])) {
        picos++;
      }
    }

    return {
      palas,
      picos,
      isWin: palas === 4,
    };
  }

  validateGuess(guess: string): { valid: boolean; error?: string } {
    if (guess.length !== 4) {
      return { valid: false, error: 'Guess must be 4 digits' };
    }

    if (!/^[1-9]+$/.test(guess)) {
      return { valid: false, error: 'Digits must be between 1 and 9' };
    }

    const uniqueDigits = new Set(guess.split(''));
    if (uniqueDigits.size !== 4) {
      return { valid: false, error: 'Digits cannot repeat' };
    }

    return { valid: true };
  }
}

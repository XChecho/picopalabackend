import { Injectable } from "@nestjs/common";

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

    return selected.join("");
  }

  calculateFeedback(guess: string, secret: string): MoveFeedback {
    // Pico (fija): correct digit in the correct position.
    // Pala: correct digit in a different position.
    let picos = 0;
    let palas = 0;
    // Secret digits not already matched as picos; each can award at most one pala.
    const unmatched = new Map<string, number>();

    for (let i = 0; i < 4; i++) {
      if (guess[i] === secret[i]) {
        picos++;
      } else {
        unmatched.set(secret[i], (unmatched.get(secret[i]) ?? 0) + 1);
      }
    }

    for (let i = 0; i < 4; i++) {
      if (guess[i] === secret[i]) continue;
      const available = unmatched.get(guess[i]) ?? 0;
      if (available > 0) {
        palas++;
        unmatched.set(guess[i], available - 1);
      }
    }

    return {
      palas,
      picos,
      isWin: picos === 4,
    };
  }

  validateGuess(guess: string): { valid: boolean; error?: string } {
    if (guess.length !== 4) {
      return { valid: false, error: "Guess must be 4 digits" };
    }

    if (!/^[1-9]+$/.test(guess)) {
      return { valid: false, error: "Digits must be between 1 and 9" };
    }

    const uniqueDigits = new Set(guess.split(""));
    if (uniqueDigits.size !== 4) {
      return { valid: false, error: "Digits cannot repeat" };
    }

    return { valid: true };
  }
}

export interface IFeedback {
  picos: number;
  palas: number;
}

/** Pico = right digit, right position. Pala = right digit, other position. */
export function feedbackFor(guess: string, secret: string): IFeedback {
  let picos = 0;
  let palas = 0;
  for (let i = 0; i < 4; i++) {
    if (guess[i] === secret[i]) picos++;
    else if (secret.includes(guess[i])) palas++;
  }
  return { picos, palas };
}

export function allCandidates(): string[] {
  const out: string[] = [];
  for (let a = 1; a <= 9; a++)
    for (let b = 1; b <= 9; b++) {
      if (b === a) continue;
      for (let c = 1; c <= 9; c++) {
        if (c === a || c === b) continue;
        for (let d = 1; d <= 9; d++) {
          if (d === a || d === b || d === c) continue;
          out.push(`${a}${b}${c}${d}`);
        }
      }
    }
  return out;
}

/** Deterministic solver: first candidate consistent with all feedback seen so far. */
export class Solver {
  private candidates = allCandidates();

  next(): string {
    if (this.candidates.length === 0)
      throw new Error("Solver has no candidates left");
    return this.candidates[0];
  }

  observe(guess: string, fb: IFeedback): void {
    this.candidates = this.candidates.filter((c) => {
      const f = feedbackFor(guess, c);
      return f.picos === fb.picos && f.palas === fb.palas;
    });
  }
}

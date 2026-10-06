import { GameService } from "../game.service";
import { AiService } from "./ai.service";

type AiMove = { guess: string; palas: number; picos: number };

describe("AiService", () => {
  let game: GameService;
  let ai: AiService;

  beforeEach(() => {
    game = new GameService();
    ai = new AiService(game);
  });

  const play = (
    pick: (moves: AiMove[]) => string,
    secret: string,
    maxTurns: number,
  ): { moves: AiMove[]; won: boolean } => {
    const moves: AiMove[] = [];
    for (let turn = 0; turn < maxTurns; turn++) {
      const guess = pick(moves);
      const fb = game.calculateFeedback(guess, secret);
      moves.push({ guess, palas: fb.palas, picos: fb.picos });
      if (fb.isWin) return { moves, won: true };
    }
    return { moves, won: false };
  };

  describe("easyMove", () => {
    it("returns a valid guess", () => {
      for (let i = 0; i < 100; i++) {
        expect(game.validateGuess(ai.easyMove([])).valid).toBe(true);
      }
    });

    it("does not repeat previously used guesses", () => {
      const used: string[] = [];
      for (let i = 0; i < 50; i++) {
        const guess = ai.easyMove(used);
        expect(used).not.toContain(guess);
        used.push(guess);
      }
    });

    it("gives up avoiding repeats after 100 attempts instead of looping forever", () => {
      jest.spyOn(game, "generateSecretNumber").mockReturnValue("1234");
      expect(ai.easyMove(["1234"])).toBe("1234");
      expect(game.generateSecretNumber).toHaveBeenCalledTimes(100);
    });
  });

  describe("mediumMove", () => {
    it("returns a valid guess consistent with previous feedback", () => {
      const secret = "5821";
      const first = "1234";
      const fb = game.calculateFeedback(first, secret);
      const guess = ai.mediumMove([{ guess: first, ...fb }]);
      expect(game.validateGuess(guess).valid).toBe(true);
      expect(game.calculateFeedback(first, guess)).toMatchObject({
        picos: fb.picos,
        palas: fb.palas,
      });
    });

    it("never repeats an earlier guess and eventually wins", () => {
      const { moves, won } = play((m) => ai.mediumMove(m), "7392", 15);
      expect(won).toBe(true);
      expect(new Set(moves.map((m) => m.guess)).size).toBe(moves.length);
    });
  });

  describe("hardMove", () => {
    it("returns a valid, consistent guess after one move", () => {
      const secret = "5821";
      const fb = game.calculateFeedback("1234", secret);
      const guess = ai.hardMove([{ guess: "1234", ...fb }]);
      expect(game.validateGuess(guess).valid).toBe(true);
      expect(game.calculateFeedback("1234", guess)).toMatchObject({
        picos: fb.picos,
        palas: fb.palas,
      });
    });

    it("returns the only remaining candidate", () => {
      const secret = "4821";
      const moves: AiMove[] = [
        "1234",
        "5678",
        "9123",
        "2468",
        "4821".split("").reverse().join(""),
        "8412",
      ].map((guess) => ({
        guess,
        ...game.calculateFeedback(guess, secret),
      }));
      expect(ai.hardMove(moves)).toBe(secret);
    }, 60_000);

    it("falls back to a random valid secret when feedback is contradictory", () => {
      const guess = ai.hardMove([
        { guess: "1234", picos: 4, palas: 0 },
        { guess: "5678", picos: 4, palas: 0 },
      ]);
      expect(game.validateGuess(guess).valid).toBe(true);
    });

    // The empty-board search (3024 candidates) is the expensive one, so the
    // simulated games open with a fixed first guess and let hardMove drive the rest.
    const playHard = (secret: string): { moves: AiMove[]; won: boolean } => {
      const opening = "1234";
      const fb = game.calculateFeedback(opening, secret);
      const first: AiMove = {
        guess: opening,
        palas: fb.palas,
        picos: fb.picos,
      };
      if (fb.isWin) return { moves: [first], won: true };
      const rest = play((m) => ai.hardMove([first, ...m]), secret, 11);
      return { moves: [first, ...rest.moves], won: rest.won };
    };

    it.each(["1234", "9876", "2519", "8163"])(
      "converges to a win within 12 turns against secret %s",
      (secret) => {
        const { moves, won } = playHard(secret);
        expect(won).toBe(true);
        expect(moves.length).toBeLessThanOrEqual(12);
        expect(new Set(moves.map((m) => m.guess)).size).toBe(moves.length);
      },
      60_000,
    );

    it("wins within 12 turns across random secrets", () => {
      for (let i = 0; i < 3; i++) {
        expect(playHard(game.generateSecretNumber()).won).toBe(true);
      }
    }, 120_000);

    it("answers the opening move quickly so it never blocks the event loop", () => {
      const startedAt = Date.now();
      const guess = ai.hardMove([]);
      expect(game.validateGuess(guess).valid).toBe(true);
      expect(Date.now() - startedAt).toBeLessThan(1000);
    });
  });
});

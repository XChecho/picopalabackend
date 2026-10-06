import { GameService } from "./game.service";

describe("GameService", () => {
  let service: GameService;

  beforeEach(() => {
    service = new GameService();
  });

  describe("calculateFeedback", () => {
    it("returns 4 picos and a win when the guess equals the secret", () => {
      expect(service.calculateFeedback("1234", "1234")).toEqual({
        picos: 4,
        palas: 0,
        isWin: true,
      });
    });

    it("returns 0 picos and 0 palas when no digit matches", () => {
      expect(service.calculateFeedback("1234", "5678")).toEqual({
        picos: 0,
        palas: 0,
        isWin: false,
      });
    });

    it("counts only palas when all digits are right but misplaced", () => {
      expect(service.calculateFeedback("4321", "1234")).toEqual({
        picos: 0,
        palas: 4,
        isWin: false,
      });
    });

    it("counts a mix of picos and palas", () => {
      // 1 correct position, 2 correct digits in wrong position, 1 miss
      expect(service.calculateFeedback("1325", "1234")).toEqual({
        picos: 1,
        palas: 2,
        isWin: false,
      });
    });

    it("never reports a win with fewer than 4 picos", () => {
      expect(service.calculateFeedback("1243", "1234").isWin).toBe(false);
    });

    // KNOWN BUG (see report): a repeated digit in the guess inflates palas.
    // Unreachable through the API because validateGuess rejects repeats.
    it(
      "does not inflate palas when the guess repeats a digit (guess 1123 vs secret 4156)",
      () => {
        expect(service.calculateFeedback("1123", "4156")).toMatchObject({
          picos: 1,
          palas: 0,
        });
      },
    );

    it("is symmetric in total matches for unique-digit inputs", () => {
      const a = service.calculateFeedback("1357", "7531");
      const b = service.calculateFeedback("7531", "1357");
      expect(a.picos + a.palas).toBe(b.picos + b.palas);
    });
  });

  describe("validateGuess", () => {
    it("accepts 4 unique digits between 1 and 9", () => {
      expect(service.validateGuess("1234")).toEqual({ valid: true });
      expect(service.validateGuess("9876")).toEqual({ valid: true });
    });

    it.each(["", "123", "12345"])("rejects wrong length %p", (guess) => {
      expect(service.validateGuess(guess)).toEqual({
        valid: false,
        error: "Guess must be 4 digits",
      });
    });

    it.each(["1204", "abcd", "12 4", "-123"])(
      "rejects non 1-9 characters %p",
      (guess) => {
        expect(service.validateGuess(guess)).toEqual({
          valid: false,
          error: "Digits must be between 1 and 9",
        });
      },
    );

    it.each(["1123", "1111", "1231"])("rejects repeated digits %p", (guess) => {
      expect(service.validateGuess(guess)).toEqual({
        valid: false,
        error: "Digits cannot repeat",
      });
    });
  });

  describe("generateSecretNumber", () => {
    it("always produces 4 unique digits between 1 and 9", () => {
      for (let i = 0; i < 2000; i++) {
        const secret = service.generateSecretNumber();
        expect(secret).toMatch(/^[1-9]{4}$/);
        expect(new Set(secret).size).toBe(4);
        expect(service.validateGuess(secret).valid).toBe(true);
      }
    });

    it("produces varied values", () => {
      const seen = new Set<string>();
      for (let i = 0; i < 200; i++) seen.add(service.generateSecretNumber());
      expect(seen.size).toBeGreaterThan(50);
    });
  });
});

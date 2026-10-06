import { Rank } from "@prisma/client";
import { EloService } from "./elo.service";

describe("EloService", () => {
  let service: EloService;

  beforeEach(() => {
    service = new EloService();
  });

  describe("calculateDelta", () => {
    it("gives +16 for a win between equal ratings with K=32", () => {
      expect(service.calculateDelta(1000, 1000, 1)).toBe(16);
    });

    it("gives -16 for a loss between equal ratings", () => {
      expect(service.calculateDelta(1000, 1000, 0)).toBe(-16);
    });

    it("gives 0 for a draw between equal ratings", () => {
      expect(service.calculateDelta(1000, 1000, 0.5)).toBe(0);
    });

    it("rewards an upset more than an expected win", () => {
      const upset = service.calculateDelta(1000, 1400, 1);
      const expected = service.calculateDelta(1400, 1000, 1);
      expect(upset).toBeGreaterThan(expected);
      expect(upset).toBe(29);
      expect(expected).toBe(3);
    });

    it("honours a custom K factor", () => {
      expect(service.calculateDelta(1000, 1000, 1, 64)).toBe(32);
    });
  });

  describe("calculateRank", () => {
    it.each([
      [0, Rank.BRONCE],
      [999, Rank.BRONCE],
      [1000, Rank.PLATA],
      [1499, Rank.PLATA],
      [1500, Rank.ORO],
      [1999, Rank.ORO],
      [2000, Rank.PLATINO],
      [2499, Rank.PLATINO],
      [2500, Rank.DIAMANTE],
      [9999, Rank.DIAMANTE],
    ])("maps elo %i to %s", (elo, rank) => {
      expect(service.calculateRank(elo)).toBe(rank);
    });
  });

  describe("computeOutcome", () => {
    it("applies a win for A and a loss for B symmetrically", () => {
      const { a, b } = service.computeOutcome(
        { elo: 1200, score: 1 },
        { elo: 1200, score: 0 },
      );
      expect(a.eloAfter - a.eloBefore).toBe(16);
      expect(b.eloAfter - b.eloBefore).toBe(-16);
    });

    it("is zero-sum for equal ratings and symmetric deltas for a draw", () => {
      const { a, b } = service.computeOutcome(
        { elo: 1300, score: 0.5 },
        { elo: 1100, score: 0.5 },
      );
      const da = a.eloAfter - a.eloBefore;
      const db = b.eloAfter - b.eloBefore;
      expect(da).toBeLessThan(0);
      expect(db).toBeGreaterThan(0);
      expect(da + db).toBe(0);
    });

    it("swapping sides mirrors the outcome", () => {
      const x = service.computeOutcome(
        { elo: 1500, score: 1 },
        { elo: 1100, score: 0 },
      );
      const y = service.computeOutcome(
        { elo: 1100, score: 0 },
        { elo: 1500, score: 1 },
      );
      expect(x.a).toEqual(y.b);
      expect(x.b).toEqual(y.a);
    });

    it("never drops below zero", () => {
      const { b } = service.computeOutcome(
        { elo: 3000, score: 1 },
        { elo: 5, score: 0 },
      );
      expect(b.eloAfter).toBeGreaterThanOrEqual(0);
    });

    it("reports rank changes on promotion and demotion", () => {
      const { a, b } = service.computeOutcome(
        { elo: 999, score: 1 },
        { elo: 1000, score: 0 },
      );
      expect(a.rankBefore).toBe(Rank.BRONCE);
      expect(a.rankAfter).toBe(Rank.PLATA);
      expect(b.rankBefore).toBe(Rank.PLATA);
      expect(b.rankAfter).toBe(Rank.BRONCE);
    });
  });
});

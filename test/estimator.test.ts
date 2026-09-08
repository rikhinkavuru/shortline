import { describe, expect, it } from "vitest";
import { buildEstimate, classifySignal, combineStrata, wilson } from "../src/domain/estimator.js";

describe("wilson", () => {
  it("matches a textbook value (x=7, n=10)", () => {
    const w = wilson(7, 10);
    expect(w.p).toBeCloseTo(0.7, 10);
    expect(w.low).toBeCloseTo(0.3968, 3);
    expect(w.high).toBeCloseTo(0.8922, 3);
  });
  it("never leaves [0, 1] at the extremes", () => {
    expect(wilson(0, 5).low).toBe(0);
    expect(wilson(5, 5).high).toBe(1);
    expect(wilson(0, 5).high).toBeGreaterThan(0);
    expect(wilson(5, 5).low).toBeLessThan(1);
  });
  it("rejects impossible inputs", () => {
    expect(() => wilson(3, 0)).toThrow();
    expect(() => wilson(6, 5)).toThrow();
  });
});

const stratum = (over: Partial<Parameters<typeof combineStrata>[0][number]>) => ({
  stratum: "r|chain",
  region: "r",
  kind: "chain" as const,
  frameSize: 10,
  planned: 4,
  usable: 4,
  available: 2,
  inStock: 2,
  limited: 0,
  ...over
});

describe("combineStrata", () => {
  it("weights strata by frame size and applies the finite population correction", () => {
    const out = combineStrata([
      stratum({ stratum: "a", frameSize: 30, usable: 3, available: 3 }),
      stratum({ stratum: "b", frameSize: 10, usable: 2, available: 0 })
    ]);
    expect(out.method).toBe("stratified");
    expect(out.pHat).toBeCloseTo(0.75, 10);
    expect(out.coverage).toBe(1);
    // p̂_h ∈ {0, 1} in both strata -> zero sampling variance -> interval collapses on the point.
    expect(out.low).toBeCloseTo(0.75, 10);
    expect(out.high).toBeCloseTo(0.75, 10);
  });
  it("falls back to a pooled Wilson interval when a stratum has one usable observation", () => {
    const out = combineStrata([stratum({ stratum: "a", usable: 1, available: 1 }), stratum({ stratum: "b", usable: 4, available: 1 })]);
    expect(out.method).toBe("pooled_wilson");
    const w = wilson(2, 5);
    expect(out.pHat).toBeCloseTo(w.p, 10);
    expect(out.low).toBeCloseTo(w.low, 10);
  });
  it("reports coverage below one when a stratum produced nothing usable", () => {
    const out = combineStrata([stratum({ stratum: "a", frameSize: 10, usable: 3, available: 1 }), stratum({ stratum: "b", frameSize: 30, usable: 0, available: 0 })]);
    expect(out.coverage).toBeCloseTo(0.25, 10);
    expect(out.pHat).toBeCloseTo(1 / 3, 10);
  });
  it("returns nulls with no usable observations at all", () => {
    const out = combineStrata([stratum({ usable: 0, available: 0 })]);
    expect(out.pHat).toBeNull();
    expect(out.coverage).toBe(0);
  });
});

describe("classifySignal", () => {
  const thresholds = { shortageUpper: 0.5, strainedPoint: 0.7 };
  it("needs enough usable observations", () => {
    expect(classifySignal({ pHat: 0.2, high: 0.3 }, 3, 6, thresholds)).toBe("insufficient_data");
  });
  it("calls shortage only when the whole interval sits below the line", () => {
    expect(classifySignal({ pHat: 0.3, high: 0.49 }, 10, 6, thresholds)).toBe("shortage");
    expect(classifySignal({ pHat: 0.3, high: 0.55 }, 10, 6, thresholds)).toBe("strained");
    expect(classifySignal({ pHat: 0.8, high: 0.95 }, 10, 6, thresholds)).toBe("available");
  });
});

describe("buildEstimate", () => {
  it("carries counts, response rate, and the simulated flag", () => {
    const est = buildEstimate({
      watchId: "w",
      isoWeek: "2026-W30",
      computedAt: new Date("2026-07-22T00:00:00Z"),
      strata: [stratum({ planned: 5, usable: 4, available: 3, inStock: 2, limited: 1 })],
      minUsual: 0 as never,
      minUsable: 3,
      thresholds: { shortageUpper: 0.5, strainedPoint: 0.7 },
      simulated: true
    } as never);
    expect(est.responseRate).toBeCloseTo(0.8, 10);
    expect(est.strata[0]?.limited).toBe(1);
    expect(est.signal).toBe("available");
    expect(est.simulated).toBe(true);
  });
});

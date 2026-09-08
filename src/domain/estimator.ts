import type { Estimate, Signal, SiteKind, StratumEstimate, WatchThresholds } from "./types.js";

const Z95 = 1.959964;

export interface Interval {
  p: number;
  low: number;
  high: number;
}

/**
 * Wilson score interval. Preferred over the Wald interval for the small
 * per-stratum samples Shortline works with: it never leaves [0, 1] and keeps
 * reasonable coverage even when x is 0 or n.
 */
export function wilson(x: number, n: number, z = Z95): Interval {
  if (n <= 0) {
    throw new Error("wilson: n must be positive");
  }
  if (x < 0 || x > n) {
    throw new Error("wilson: x must be within [0, n]");
  }
  const p = x / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export interface StratumCounts {
  stratum: string;
  region: string;
  kind: SiteKind;
  frameSize: number;
  planned: number;
  usable: number;
  available: number;
  inStock: number;
  limited: number;
}

interface Combined {
  method: "stratified" | "pooled_wilson";
  pHat: number | null;
  low: number | null;
  high: number | null;
  coverage: number;
}

/**
 * Stratified estimate of availability with finite-population correction.
 *
 *   p̂  = Σ W_h p̂_h            W_h = N_h / N over covered strata
 *   SE² = Σ W_h² (1 − n_h/N_h) p̂_h(1 − p̂_h) / (n_h − 1)
 *
 * Falls back to a pooled Wilson interval when any covered stratum has fewer
 * than two usable observations, because the per-stratum variance is then
 * undefined. The method used is always reported alongside the numbers.
 */
export function combineStrata(strata: StratumCounts[]): Combined {
  const covered = strata.filter((s) => s.usable > 0 && s.frameSize > 0);
  const frameTotal = strata.reduce((acc, s) => acc + Math.max(0, s.frameSize), 0);
  if (covered.length === 0 || frameTotal === 0) {
    return { method: "stratified", pHat: null, low: null, high: null, coverage: 0 };
  }
  const coveredFrame = covered.reduce((acc, s) => acc + s.frameSize, 0);
  const coverage = coveredFrame / frameTotal;
  const canStratify = covered.every((s) => s.usable >= 2);
  if (!canStratify) {
    const x = covered.reduce((acc, s) => acc + s.available, 0);
    const n = covered.reduce((acc, s) => acc + s.usable, 0);
    const w = wilson(x, n);
    return { method: "pooled_wilson", pHat: w.p, low: w.low, high: w.high, coverage };
  }
  let pHat = 0;
  let variance = 0;
  for (const s of covered) {
    const weight = s.frameSize / coveredFrame;
    const ph = s.available / s.usable;
    const fpc = Math.max(0, 1 - Math.min(s.usable, s.frameSize) / s.frameSize);
    pHat += weight * ph;
    variance += weight * weight * fpc * ((ph * (1 - ph)) / (s.usable - 1));
  }
  const se = Math.sqrt(variance);
  return {
    method: "stratified",
    pHat,
    low: Math.max(0, pHat - Z95 * se),
    high: Math.min(1, pHat + Z95 * se),
    coverage
  };
}

export function classifySignal(
  overall: { pHat: number | null; high: number | null },
  usable: number,
  minUsable: number,
  thresholds: WatchThresholds
): Signal {
  if (overall.pHat === null || overall.high === null || usable < minUsable) {
    return "insufficient_data";
  }
  if (overall.high < thresholds.shortageUpper) {
    return "shortage";
  }
  if (overall.pHat < thresholds.strainedPoint) {
    return "strained";
  }
  return "available";
}

export interface EstimateInput {
  watchId: string;
  isoWeek: string;
  computedAt: Date;
  strata: StratumCounts[];
  minUsable: number;
  thresholds: WatchThresholds;
  simulated: boolean;
}

export function buildEstimate(input: EstimateInput): Estimate {
  const strata: StratumEstimate[] = input.strata.map((s) => {
    const iv = s.usable > 0 ? wilson(s.available, s.usable) : null;
    return {
      stratum: s.stratum,
      region: s.region,
      kind: s.kind,
      frameSize: s.frameSize,
      planned: s.planned,
      usable: s.usable,
      available: s.available,
      inStock: s.inStock,
      limited: s.limited,
      pHat: iv ? iv.p : null,
      low: iv ? iv.low : null,
      high: iv ? iv.high : null
    };
  });
  const combined = combineStrata(input.strata);
  const planned = input.strata.reduce((acc, s) => acc + s.planned, 0);
  const usable = input.strata.reduce((acc, s) => acc + s.usable, 0);
  const overall = { pHat: combined.pHat, low: combined.low, high: combined.high };
  return {
    watchId: input.watchId,
    isoWeek: input.isoWeek,
    computedAt: input.computedAt.toISOString(),
    strata,
    method: combined.method,
    overall,
    coverage: combined.coverage,
    planned,
    usable,
    responseRate: planned > 0 ? usable / planned : null,
    signal: classifySignal(overall, usable, input.minUsable, input.thresholds),
    simulated: input.simulated
  };
}

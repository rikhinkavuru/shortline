/**
 * Shortline evaluation harness: a deterministic Monte Carlo over the pure
 * domain layer (no network, no sqlite, no CALL-E). Each simulated week fixes a
 * finite-population truth over a 36-site frame, draws the real stratified panel
 * with `planSweep`, scripts each call with the dry-run scenarios, gates evidence
 * with the real `classifyRecipient`, and runs the counts through
 * `combineStrata` + `classifySignal` exactly as `src/app/estimate.ts` does.
 *
 *   node --disable-warning=ExperimentalWarning --import tsx src/eval.ts
 */
import { DEFAULT_MIX, SCENARIOS, pickScenario } from "./calle/scenarios.js";
import { type RecipientSnapshot, classifyRecipient } from "./domain/classify.js";
import { type StratumCounts, classifySignal, combineStrata } from "./domain/estimator.js";
import { hashString, mulberry32, seededShuffle } from "./domain/random.js";
import { type FrameEntry, planSweep } from "./domain/sampling.js";
import type { Product, Signal, SiteKind, Watch, WatchThresholds } from "./domain/types.js";

const SEED = 20260907;
const WEEKS = 10000;
const REGIONS = ["US-CA-SF", "US-NY-NYC", "US-TX-HOU"];
const KINDS: SiteKind[] = ["chain", "independent"];
const SITES_PER_STRATUM = 6;
const THRESHOLDS: WatchThresholds = { shortageUpper: 0.5, strainedPoint: 0.7 };
const MIN_USABLE = 6;
const PRODUCT: Product = { name: "albuterol", strength: "90 mcg", form: "inhaler" };
const NOW = new Date("2026-09-07T17:00:00Z");
const WATCH: Watch = {
  id: "eval", product: PRODUCT, regions: REGIONS, panelPerStratum: 3, cooldownDays: 14, globalMinGapDays: 5,
  window: { start: "09:00", end: "17:00", days: [1, 2, 3, 4, 5] }, thresholds: THRESHOLDS, minUsable: MIN_USABLE,
  status: "active", createdAt: NOW.toISOString()
};
const FRAME: FrameEntry[] = REGIONS.flatMap((region) => KINDS.flatMap((kind) => Array.from({ length: SITES_PER_STRATUM }, (_, i): FrameEntry => ({
  site: { id: `${region}|${kind}|${i}`, name: `Site ${i}`, kind, phone: "+15550100000", region, timezone: "America/Chicago", source: { kind: "fixture", ref: "eval" }, optOut: false, createdAt: NOW.toISOString() },
  history: { lastAskedForWatch: null, lastCalledAny: null, carries: true, refusedAt: null, wrongNumber: false }
}))));
const SITE_IDS = FRAME.map((f) => f.site.id);
const N = SITE_IDS.length;

/** DEFAULT_MIX with the answer forced to agree with the site's true state; the fabricated quote is driven by `r` instead of its 1% weight. */
const USABLE_NAMES = new Set(["in_stock_human", "ivr_then_in_stock", "limited_human", "out_of_stock_human"]);
const weightOf = (mix: Array<[string, number]>): number => mix.reduce((acc, [, w]) => acc + w, 0);
const NONRESPONSE_MIX = DEFAULT_MIX.filter(([n]) => !USABLE_NAMES.has(n) && n !== "unattributed_quote");
const AVAILABLE_MIX = DEFAULT_MIX.filter(([n]) => USABLE_NAMES.has(n) && n !== "out_of_stock_human");
const NONRESPONSE_SHARE = weightOf(NONRESPONSE_MIX) / (weightOf(NONRESPONSE_MIX) + weightOf(DEFAULT_MIX.filter(([n]) => USABLE_NAMES.has(n))));

function drawScenario(rng: () => number, available: boolean, r: number): string {
  if (rng() < NONRESPONSE_SHARE) {
    return pickScenario(rng(), NONRESPONSE_MIX);
  }
  if (available) {
    return pickScenario(rng(), AVAILABLE_MIX);
  }
  return rng() < r ? "unattributed_quote" : "out_of_stock_human";
}

/** One verdict per scenario, from the real evidence gate on the real scripted transcript. Memoised: scenarios are static. */
interface Verdict { gated: boolean; ungated: boolean; outcome: string }
const verdicts = new Map<string, Verdict>();
function verdict(name: string): Verdict {
  const cached = verdicts.get(name);
  if (cached) {
    return cached;
  }
  const sc = SCENARIOS[name];
  if (!sc) {
    throw new Error(`unknown scenario ${name}`);
  }
  const snap: RecipientSnapshot = { recipientId: name, phone: "+15550100000", status: sc.recipientStatus, structuredResult: sc.structuredResult, transcript: sc.turns(`${PRODUCT.name} ${PRODUCT.strength} ${PRODUCT.form}`), attemptFailureCode: sc.failureCode ?? null };
  const c = classifyRecipient(PRODUCT, snap, "strict");
  const sr = sc.structuredResult ?? {};
  const outcome = typeof sr.availability === "string" ? sr.availability : "unknown";
  const ungated = ["in_stock", "limited", "out_of_stock"].includes(outcome) && sr.answered_by === "human" && sr.reached_pharmacy === "yes";
  if (c.usable && c.outcome !== outcome) {
    throw new Error(`gate outcome mismatch for ${name}`);
  }
  const v = { gated: c.usable, ungated, outcome };
  verdicts.set(name, v);
  return v;
}

interface Est { method: "stratified" | "pooled_wilson"; pHat: number | null; low: number | null; high: number | null; usable: number; signal: Signal }

/** Mirrors the per-observation counting in src/app/estimate.ts. */
function tally(entry: StratumCounts, usable: boolean, outcome: string): void {
  if (!usable) {
    return;
  }
  entry.usable += 1;
  entry.available += outcome === "in_stock" || outcome === "limited" ? 1 : 0;
  entry.inStock += outcome === "in_stock" ? 1 : 0;
  entry.limited += outcome === "limited" ? 1 : 0;
}

function estimate(strata: StratumCounts[]): Est {
  const c = combineStrata(strata);
  const usable = strata.reduce((acc, s) => acc + s.usable, 0);
  return { method: c.method, pHat: c.pHat, low: c.low, high: c.high, usable, signal: classifySignal(c, usable, MIN_USABLE, THRESHOLDS) };
}

/** One week: fixed truth per site, real panel draw, scripted calls, real gate, real estimator. */
function simulateWeek(rng: () => number, tag: string, week: number, states: Map<string, boolean>, r: number): { truth: number; gated: Est; ungated: Est } {
  const plan = planSweep(WATCH, FRAME, `${tag}:${week}`, NOW);
  const gated: StratumCounts[] = [];
  const ungated: StratumCounts[] = [];
  for (const [key, sites] of plan.bySite) {
    const [region, kind] = key.split("|") as [string, SiteKind];
    const blank = (): StratumCounts => ({ stratum: key, region, kind, frameSize: plan.frameSizes.get(key) ?? 0, planned: sites.length, usable: 0, available: 0, inStock: 0, limited: 0 });
    const g = blank();
    const u = blank();
    for (const site of sites) {
      const v = verdict(drawScenario(rng, states.get(site.id) === true, r));
      tally(g, v.gated, v.outcome);
      tally(u, v.ungated, v.outcome);
    }
    gated.push(g);
    ungated.push(u);
  }
  const truth = [...states.values()].filter(Boolean).length / N;
  return { truth, gated: estimate(gated), ungated: estimate(ungated) };
}

const bernoulliStates = (rng: () => number, q: number): Map<string, boolean> => new Map(SITE_IDS.map((id) => [id, rng() < q]));
const exactStates = (tag: string, week: number, k: number): Map<string, boolean> => new Map(seededShuffle(SITE_IDS, `${tag}:${week}:truth`).map((id, i) => [id, i < k]));
const rngFor = (tag: string): (() => number) => mulberry32(hashString(`${SEED}:${tag}`));
const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;
const row = (cells: Array<string | number>, widths: number[]): string => cells.map((c, i) => String(c).padEnd(widths[i] ?? 0)).join("  ").trimEnd();

function main(): void {
  const t0 = performance.now();
  const lines: string[] = [];
  lines.push(`Shortline eval  seed=${SEED}  weeks=${WEEKS} per configuration  frame=${N} sites (${REGIONS.length} regions x ${KINDS.join("/")} x ${SITES_PER_STRATUM})  panel=3 per stratum`);
  lines.push(`Mix: nonresponse ${pct(NONRESPONSE_SHARE)} (${NONRESPONSE_MIX.map(([n]) => n).join(", ")}); usable answers agree with the site's true state; fabricated in_stock quote at rate r for out-of-stock sites`);

  // (a) 95% interval coverage of the realised finite-population share, r = 0.
  const cov = { stratified: { hit: 0, n: 0, width: 0 }, pooled_wilson: { hit: 0, n: 0, width: 0 }, overall: { hit: 0, n: 0, width: 0 } };
  let noEstimate = 0;
  const rngA = rngFor("coverage");
  for (let w = 0; w < WEEKS; w += 1) {
    const { truth, gated } = simulateWeek(rngA, `coverage:${SEED}`, w, bernoulliStates(rngA, 0.15 + 0.8 * rngA()), 0);
    if (gated.pHat === null || gated.low === null || gated.high === null) {
      noEstimate += 1;
      continue;
    }
    for (const c of [cov[gated.method], cov.overall]) {
      c.n += 1;
      c.width += gated.high - gated.low;
      c.hit += gated.low <= truth && truth <= gated.high ? 1 : 0;
    }
  }
  const wA = [14, 10, 10, 10];
  lines.push("", "(a) 95% interval coverage of the true finite-population share, per-week availability probability ~ U(0.15, 0.95), r = 0");
  lines.push(row(["branch", "coverage", "weeks", "mean width"], wA));
  for (const [name, c] of Object.entries(cov)) {
    lines.push(row([name, pct(c.hit / c.n), c.n, (c.width / c.n).toFixed(3)], wA));
  }
  lines.push(`weeks with no estimate: ${noEstimate}`);

  // (b) shortage rules: upper-bound (classifySignal) versus naive point estimate, line 0.5.
  const wB = [14, 18, 18, 20];
  lines.push("", `(b) shortage declarations, line ${THRESHOLDS.shortageUpper}, minUsable ${MIN_USABLE}, r = 0 (exactly k of ${N} sites available each week)`);
  lines.push(row(["true share", "upper-bound rule", "naive point rule", "reading"], wB));
  for (const [k, reading] of [[20, "false-shortage rate"], [16, "detection rate"]] as const) {
    const rng = rngFor(`rules:${k}`);
    const hits = { upper: 0, naive: 0 };
    for (let w = 0; w < WEEKS; w += 1) {
      const { gated } = simulateWeek(rng, `rules:${k}:${SEED}`, w, exactStates(`rules:${k}:${SEED}`, w, k), 0);
      hits.upper += gated.signal === "shortage" ? 1 : 0;
      hits.naive += gated.pHat !== null && gated.usable >= MIN_USABLE && gated.pHat < THRESHOLDS.shortageUpper ? 1 : 0;
    }
    lines.push(row([`${k}/${N} = ${(k / N).toFixed(3)}`, pct(hits.upper / WEEKS), pct(hits.naive / WEEKS), reading], wB));
  }

  // (c) mean bias of the point estimate, evidence gate on versus off, at true share 0.5.
  const wC = [6, 14, 14, 18, 18];
  lines.push("", `(c) mean bias of the point estimate (p_hat - truth) at true share ${18 / N}, evidence gate on (classifyRecipient) versus off (schema-valid answers only)`);
  lines.push(row(["r", "gated bias", "ungated bias", "gated mean usable", "ungated mean usable"], wC));
  for (const r of [0, 0.1, 0.2]) {
    const rng = rngFor(`bias:${r}`);
    const acc = { g: 0, gn: 0, gu: 0, u: 0, un: 0, uu: 0 };
    for (let w = 0; w < WEEKS; w += 1) {
      const { truth, gated, ungated } = simulateWeek(rng, `bias:${r}:${SEED}`, w, exactStates(`bias:${r}:${SEED}`, w, N / 2), r);
      if (gated.pHat !== null) {
        acc.g += gated.pHat - truth;
        acc.gn += 1;
      }
      if (ungated.pHat !== null) {
        acc.u += ungated.pHat - truth;
        acc.un += 1;
      }
      acc.gu += gated.usable;
      acc.uu += ungated.usable;
    }
    lines.push(row([r.toFixed(1), (acc.g / acc.gn).toFixed(4), (acc.u / acc.un).toFixed(4), (acc.gu / WEEKS).toFixed(2), (acc.uu / WEEKS).toFixed(2)], wC));
  }
  lines.push("", `elapsed ${((performance.now() - t0) / 1000).toFixed(2)}s`);
  console.log(lines.join("\n"));
}

main();

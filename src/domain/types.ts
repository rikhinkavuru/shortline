/**
 * Core domain types for Shortline.
 *
 * Shortline treats a phone call as a *measurement*: a noisy observation of
 * whether one pharmacy has one product in stock at one moment. Everything
 * else in the domain layer exists to (a) decide which sites to measure and
 * when, (b) turn CALL-E's structured result into an observation with an
 * explicit usability verdict, and (c) combine observations into an estimate
 * with honest uncertainty.
 */

export type SiteKind = "chain" | "independent" | "hospital_outpatient" | "wholesaler_branch" | "other";

export interface SiteSource {
  kind: "fixture" | "manual" | "nppes" | "csv";
  ref: string;
}

export interface Site {
  id: string;
  name: string;
  kind: SiteKind;
  /** Canonical E.164. Stored only here; everywhere else use `maskPhone`. */
  phone: string;
  /** Region code, e.g. `US-CA-SF`. Together with `kind` it forms the stratum. */
  region: string;
  /** IANA timezone, e.g. `America/Los_Angeles`. Required, never inferred from the phone. */
  timezone: string;
  lat?: number;
  lng?: number;
  source: SiteSource;
  optOut: boolean;
  optOutReason?: string;
  /**
   * Operator-owned test line (your own phone). Exempt from calling windows
   * and cooldowns, allowed in sourcing requests, never part of a sweep frame
   * or an estimate.
   */
  testLine?: boolean;
  /** Fixture-only: which fake scenario this site plays in dry-run mode. */
  scenario?: string;
  createdAt: string;
}

export interface Product {
  name: string;
  strength?: string;
  form?: string;
  /** Optional NDC or other identifier, for display only. */
  code?: string;
}

export interface CallWindow {
  /** Local start time, `HH:MM`. */
  start: string;
  /** Local end time, `HH:MM` (exclusive). */
  end: string;
  /** ISO weekdays allowed, 1 = Monday ... 7 = Sunday. */
  days: number[];
}

export interface WatchThresholds {
  /** Shortage signal when the upper 95% bound of availability is below this. */
  shortageUpper: number;
  /** Strained signal when the point estimate is below this. */
  strainedPoint: number;
}

export interface Watch {
  id: string;
  product: Product;
  regions: string[];
  /** Target usable observations per stratum per sweep. */
  panelPerStratum: number;
  /** Days before the same site may be asked about the same product again. */
  cooldownDays: number;
  /** Minimum days between any two Shortline calls to the same site, across watches. */
  globalMinGapDays: number;
  window: CallWindow;
  thresholds: WatchThresholds;
  /** Fewer usable observations than this yields `insufficient_data`. */
  minUsable: number;
  status: "active" | "paused";
  createdAt: string;
}

export type DispatchKind = "sweep" | "find";

/**
 * Application-side lifecycle for one submission to CALL-E. Deliberately
 * separate from CALL-E's call status; see docs/safety.md.
 */
export type DispatchState =
  | "reserved"
  | "submission_unknown"
  | "accepted"
  | "terminal_unverified"
  | "terminal_verified"
  | "needs_human";

export interface Dispatch {
  id: string;
  kind: DispatchKind;
  watchId: string | null;
  findRequestId: string | null;
  sweepId: string | null;
  waveIndex: number | null;
  idempotencyKey: string;
  siteIds: string[];
  taskText: string;
  schemaVersion: string;
  state: DispatchState;
  callId: string | null;
  simulated: boolean;
  createdAt: string;
  submittedAt: string | null;
  terminalAt: string | null;
  note: string | null;
}

export type ObservationOutcome =
  | "in_stock"
  | "limited"
  | "out_of_stock"
  | "not_carried"
  | "refused"
  | "unknown"
  | "voicemail"
  | "ivr_dead_end"
  | "not_reached"
  | "unreachable";

export type AnsweredBy = "human" | "ivr" | "voicemail" | "unknown";

export interface Observation {
  id: string;
  watchId: string | null;
  findRequestId: string | null;
  siteId: string;
  dispatchId: string;
  callId: string;
  recipientId: string;
  source: DispatchKind;
  observedAt: string;
  outcome: ObservationOutcome;
  answeredBy: AnsweredBy;
  reachedPharmacy: "yes" | "no" | "unknown";
  restockExpectation: string;
  quantityNote: string;
  evidenceQuote: string;
  /** Task-level confidence reported by CALL-E for the whole call task. */
  taskConfidenceScore: number | null;
  taskConfidenceLabel: string | null;
  doNotCallRequest: boolean;
  holdResponse: "offered" | "declined" | "not_asked" | "unknown";
  /** Whether this observation may enter the estimator. */
  usable: boolean;
  usableReason: string;
  simulated: boolean;
  transcriptTurns: number;
}

export interface StratumEstimate {
  stratum: string;
  region: string;
  kind: SiteKind;
  /** Frame size: sites in this stratum believed to carry the product. */
  frameSize: number;
  planned: number;
  usable: number;
  available: number;
  inStock: number;
  limited: number;
  pHat: number | null;
  low: number | null;
  high: number | null;
}

export type Signal = "insufficient_data" | "available" | "strained" | "shortage";

export interface Estimate {
  watchId: string;
  isoWeek: string;
  computedAt: string;
  strata: StratumEstimate[];
  method: "stratified" | "pooled_wilson";
  /** `nEff` is the effective sample size behind the interval (equals usable count for the pooled method). */
  overall: { pHat: number | null; low: number | null; high: number | null; nEff: number | null };
  /** Share of the frame covered by strata that produced at least one usable observation. */
  coverage: number;
  planned: number;
  usable: number;
  responseRate: number | null;
  signal: Signal;
  simulated: boolean;
}

export interface Sweep {
  id: string;
  watchId: string;
  isoWeek: string;
  plannedSiteIds: string[];
  undersampledStrata: string[];
  createdAt: string;
  status: "planned" | "dispatching" | "complete";
}

export type FindStatus = "planned" | "running" | "met" | "exhausted" | "stopped" | "needs_human";

export interface FindRequest {
  id: string;
  watchId: string | null;
  product: Product;
  region: string;
  /** Number of confirmed sources wanted. */
  need: number;
  waveSize: number;
  maxWaves: number;
  askHold: boolean;
  /** Restrict candidates to these site ids (smoke tests, single-site checks). */
  onlySiteIds?: string[];
  status: FindStatus;
  plannedSiteIds: string[];
  usedSiteIds: string[];
  confirmedSiteIds: string[];
  createdAt: string;
  updatedAt: string;
}

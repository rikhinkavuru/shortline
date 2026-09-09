import { SCHEMA_VERSION, findIdempotencyKey, newId } from "../domain/ids.js";
import { maskPhone } from "../domain/phone.js";
import { assertProduct, buildTaskText, productLabel } from "../domain/task.js";
import { withinWindow } from "../domain/time.js";
import type { CallWindow, Dispatch, FindRequest, Observation, Product, Site } from "../domain/types.js";
import { type FindCandidate, type RankedCandidate, haversineKm, nextWave, rankCandidates } from "../domain/waves.js";
import type { AppContext } from "./context.js";
import { submitDispatch } from "./dispatch.js";
import { applyFindObservations } from "./find-state.js";
import { settle } from "./reconcile.js";

export interface PlanFindInput {
  watchId?: string;
  product?: Product;
  region: string;
  near?: { lat: number; lng: number };
  need?: number;
  waveSize?: number;
  maxWaves?: number;
  askHold?: boolean;
  ignoreWindow?: boolean;
  window?: CallWindow;
  /** Restrict candidates to these site ids, e.g. an operator's own test line for a live smoke test. */
  onlySiteIds?: string[];
}

export interface FindPreview {
  request: FindRequest;
  /** Sites already known in stock for this product from monitoring within the last 24 hours; no call needed. */
  knownSources: Array<{ siteId: string; name: string; phoneMasked: string; observedAt: string; outcome: string; evidenceQuote: string }>;
  candidates: Array<{ siteId: string; name: string; phoneMasked: string; basis: string; distanceKm: number | null; kind: string }>;
  skipped: Array<{ siteId: string; name: string; reason: string }>;
  /** Calls the first wave would place. */
  firstWaveCalls: number;
  /** Calls the whole request could place if every wave runs. */
  maxCalls: number;
  /** Kept for older callers; equals `firstWaveCalls`. */
  estimatedCalls: number;
}

const DEFAULT_WINDOW: CallWindow = { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5, 6] };
const KNOWN_FRESH_HOURS = 24;
const IN_FLIGHT_WINDOW_MS = 120 * 60 * 1000;
const REGION = /^[A-Z0-9-]{2,32}$/;

export function productKey(product: Product): string {
  return productLabel(product).trim().toLowerCase();
}

/** Ignoring calling hours is a dry-run convenience. In live mode it is refused, never silently masked. */
export function resolveIgnoreWindow(ctx: AppContext, requested: boolean | undefined): boolean {
  if (requested && ctx.config.mode === "live") {
    throw new Error("ignoreWindow (--ignore-window) is only allowed in dry-run mode");
  }
  return Boolean(requested);
}

function productOfObservation(ctx: AppContext, obs: Observation): Product | null {
  if (obs.watchId) {
    return ctx.repo.getWatch(obs.watchId)?.product ?? null;
  }
  if (obs.findRequestId) {
    return ctx.repo.getFind(obs.findRequestId)?.product ?? null;
  }
  return null;
}

/** Latest observation for this site *about this product*; the courtesy cooldown uses any product. */
export function latestForProduct(ctx: AppContext, siteId: string, product: Product, accept?: (o: Observation) => boolean): Observation | null {
  const key = productKey(product);
  for (const obs of ctx.repo.listObservations({ siteId, limit: 20 })) {
    const p = productOfObservation(ctx, obs);
    if (p && productKey(p) === key && (!accept || accept(obs))) {
      return obs;
    }
  }
  return null;
}

/** Sites with a dispatch that is reserved, unknown, or in flight right now. */
export function sitesInFlight(ctx: AppContext): Set<string> {
  const cutoff = new Date(ctx.now().getTime() - IN_FLIGHT_WINDOW_MS).toISOString();
  return new Set(
    ctx.repo
      .listDispatches({ states: ["reserved", "submission_unknown", "accepted", "terminal_unverified"] })
      .filter((d) => d.createdAt >= cutoff)
      .flatMap((d) => d.siteIds)
  );
}

interface CandidateOptions {
  ignoreWindow: boolean;
  window: CallWindow;
  near?: { lat: number; lng: number };
}

function candidatesFor(ctx: AppContext, request: FindRequest, options: CandidateOptions): { ranked: RankedCandidate[]; skipped: Array<{ site: Site; reason: string }> } {
  const now = ctx.now();
  const skipped: Array<{ site: Site; reason: string }> = [];
  const list: FindCandidate[] = [];
  const only = request.onlySiteIds && request.onlySiteIds.length > 0 ? new Set(request.onlySiteIds) : null;
  const inFlight = sitesInFlight(ctx);
  for (const site of ctx.repo.listSites()) {
    if (only ? !only.has(site.id) : site.region !== request.region) {
      continue;
    }
    let ineligible: string | null = null;
    const history = request.watchId ? ctx.repo.siteHistory(site.id, request.watchId) : null;
    if (site.optOut) {
      ineligible = "opted_out";
    } else if (history && !history.carries) {
      ineligible = "does_not_carry";
    } else if (history?.wrongNumber) {
      ineligible = "wrong_number";
    } else if (inFlight.has(site.id)) {
      ineligible = "call_in_flight";
    } else if (!site.testLine && !options.ignoreWindow && !withinWindow(site.timezone, options.window, now)) {
      ineligible = "outside_calling_window";
    }
    const latestAny = ctx.repo.listObservations({ siteId: site.id, limit: 1 })[0] ?? null;
    if (latestAny && !site.testLine && !ineligible) {
      const ageHours = (now.getTime() - new Date(latestAny.observedAt).getTime()) / 3600000;
      if (ageHours < 24 && !(latestAny.usable && productKey(productOfObservation(ctx, latestAny) ?? { name: "" }) === productKey(request.product))) {
        ineligible = "called_in_last_24h";
      }
    }
    let recent: FindCandidate["recent"] = null;
    if (!site.testLine) {
      const latest = latestForProduct(ctx, site.id, request.product, (o) => o.usable);
      if (latest) {
        recent = { outcome: latest.outcome, observedAt: latest.observedAt, ageHours: (now.getTime() - new Date(latest.observedAt).getTime()) / 3600000 };
      }
    }
    if (!ineligible && recent && recent.ageHours <= KNOWN_FRESH_HOURS && (recent.outcome === "in_stock" || recent.outcome === "limited")) {
      ineligible = "known_source_no_call_needed";
    }
    const distanceKm = options.near && site.lat !== undefined && site.lng !== undefined ? haversineKm(options.near, { lat: site.lat, lng: site.lng }) : null;
    const candidate: FindCandidate = { site, distanceKm, recent, ineligible };
    if (ineligible) {
      skipped.push({ site, reason: ineligible });
    } else if (recent && recent.ageHours <= 72 && recent.outcome === "out_of_stock") {
      skipped.push({ site, reason: "observed_out_of_stock_recently" });
    }
    list.push(candidate);
  }
  const ranked = rankCandidates(list).filter((c) => c.basis !== "observed_out");
  return { ranked, skipped };
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Math.floor(value);
  if (!Number.isFinite(n)) {
    throw new Error("numeric options must be finite");
  }
  return Math.max(min, Math.min(max, n));
}

export function planFind(ctx: AppContext, input: PlanFindInput): FindPreview {
  const watch = input.watchId ? ctx.repo.getWatch(input.watchId) : null;
  if (input.watchId && !watch) {
    throw new Error(`watch ${input.watchId} not found`);
  }
  const rawProduct = watch?.product ?? input.product;
  if (!rawProduct) {
    throw new Error("planFind: product or watchId is required");
  }
  const product = assertProduct(rawProduct);
  const region = String(input.region ?? "").trim();
  const only = input.onlySiteIds?.filter((id) => typeof id === "string" && id.trim()).slice(0, 20) ?? [];
  if (!REGION.test(region)) {
    throw new Error("region must be 2-32 characters of A-Z, 0-9 and -");
  }
  if (watch && only.length === 0 && !watch.regions.includes(region)) {
    throw new Error(`region ${region} is not watched by ${watch.id}`);
  }
  const ignoreWindow = resolveIgnoreWindow(ctx, input.ignoreWindow);
  const now = ctx.now().toISOString();
  const request: FindRequest = {
    id: newId("fnd"),
    watchId: watch?.id ?? null,
    product,
    region,
    need: clampInt(input.need, 2, 1, 10),
    waveSize: clampInt(input.waveSize, 3, 1, ctx.config.batchSize),
    maxWaves: clampInt(input.maxWaves, 4, 1, 8),
    askHold: Boolean(input.askHold),
    ...(only.length > 0 ? { onlySiteIds: only } : {}),
    status: "planned",
    plannedSiteIds: [],
    usedSiteIds: [],
    confirmedSiteIds: [],
    createdAt: now,
    updatedAt: now
  };
  const options: CandidateOptions = { ignoreWindow, window: input.window ?? watch?.window ?? DEFAULT_WINDOW };
  if (input.near) {
    options.near = input.near;
  }
  const { ranked, skipped } = candidatesFor(ctx, request, options);
  const knownSources: FindPreview["knownSources"] = [];
  for (const s of skipped) {
    if (s.reason === "known_source_no_call_needed") {
      const obs = latestForProduct(ctx, s.site.id, product, (o) => o.usable);
      if (obs) {
        knownSources.push({ siteId: s.site.id, name: s.site.name, phoneMasked: maskPhone(s.site.phone), observedAt: obs.observedAt, outcome: obs.outcome, evidenceQuote: obs.evidenceQuote });
      }
    }
  }
  request.confirmedSiteIds = knownSources.map((k) => k.siteId);
  request.plannedSiteIds = ranked.slice(0, request.waveSize * request.maxWaves).map((c) => c.site.id);
  ctx.repo.saveFind(request);
  const remainingNeed = Math.max(0, request.need - request.confirmedSiteIds.length);
  const firstWaveCalls = remainingNeed === 0 ? 0 : Math.min(request.plannedSiteIds.length, Math.max(1, Math.min(request.waveSize, remainingNeed + 1)));
  const maxCalls = remainingNeed === 0 ? 0 : request.plannedSiteIds.length;
  ctx.bus.emit({ type: "find", findRequestId: request.id, status: "planned", confirmed: request.confirmedSiteIds.length, need: request.need });
  return {
    request,
    knownSources,
    candidates: ranked.slice(0, request.waveSize * request.maxWaves).map((c) => ({ siteId: c.site.id, name: c.site.name, phoneMasked: maskPhone(c.site.phone), basis: c.basis, distanceKm: c.distanceKm === null ? null : Math.round(c.distanceKm * 10) / 10, kind: c.site.kind })),
    skipped: skipped.filter((s) => s.reason !== "known_source_no_call_needed").map((s) => ({ siteId: s.site.id, name: s.site.name, reason: s.reason })),
    firstWaveCalls,
    maxCalls,
    estimatedCalls: firstWaveCalls
  };
}

/** Mark a planned request as stopped without ever having dialled. */
export function discardFind(ctx: AppContext, requestId: string): FindRequest {
  const request = ctx.repo.getFind(requestId);
  if (!request) {
    throw new Error(`find request ${requestId} not found`);
  }
  if (request.status !== "planned") {
    return request;
  }
  const stopped: FindRequest = { ...request, status: "stopped", updatedAt: ctx.now().toISOString() };
  ctx.repo.saveFind(stopped);
  ctx.bus.emit({ type: "find", findRequestId: stopped.id, status: stopped.status, confirmed: stopped.confirmedSiteIds.length, need: stopped.need });
  return stopped;
}

export interface RunFindOptions {
  /** Explicit confirmation that real calls may be placed. Required in every mode. */
  confirm: boolean;
  ignoreWindow?: boolean;
  window?: CallWindow;
  near?: { lat: number; lng: number };
}

function saveStatus(ctx: AppContext, request: FindRequest, status: FindRequest["status"]): FindRequest {
  const next: FindRequest = { ...request, status, updatedAt: ctx.now().toISOString() };
  ctx.repo.saveFind(next);
  ctx.bus.emit({ type: "find", findRequestId: next.id, status: next.status, confirmed: next.confirmedSiteIds.length, need: next.need });
  return next;
}

/**
 * Run sourcing waves until the need is met, the candidate list is exhausted,
 * or the wave cap is reached.
 *
 * Every iteration first finishes whatever the ledger already holds for this
 * request: a reserved or ambiguous wave is re-submitted under its original
 * idempotency key, an accepted wave is settled. Only when nothing is in
 * flight does the loop plan a new wave, numbered by the ledger, so a crash,
 * a 429, or a short final wave can never reuse a key or orphan a call.
 */
export async function runFind(ctx: AppContext, requestId: string, options: RunFindOptions): Promise<FindRequest> {
  if (!options.confirm) {
    throw new Error("runFind requires confirm: true");
  }
  let request = ctx.repo.getFind(requestId);
  if (!request) {
    throw new Error(`find request ${requestId} not found`);
  }
  if (request.status === "met" || request.status === "exhausted" || request.status === "stopped") {
    return request;
  }
  const ignoreWindow = resolveIgnoreWindow(ctx, options.ignoreWindow);
  const watch = request.watchId ? ctx.repo.getWatch(request.watchId) : null;
  const candidateOptions: CandidateOptions = { ignoreWindow, window: options.window ?? watch?.window ?? DEFAULT_WINDOW };
  if (options.near) {
    candidateOptions.near = options.near;
  }
  const taskText = buildTaskText({ product: request.product, callerName: ctx.config.callerName, askHold: request.askHold, holdWindow: "today" });
  for (;;) {
    // 1. Finish what is already in the ledger for this request.
    const open = ctx.repo.listDispatches({ findRequestId: request.id, states: ["reserved", "submission_unknown", "accepted", "terminal_unverified"] });
    if (open.length > 0) {
      for (const d of open) {
        if (d.state === "reserved" || d.state === "submission_unknown") {
          const sites = d.siteIds.map((id) => ctx.repo.getSite(id)).filter((s): s is Site => s !== null);
          const submitted = await submitDispatch(ctx, { dispatch: d, sites, product: request.product, askHold: request.askHold });
          if (submitted.state !== "accepted") {
            return saveStatus(ctx, request, "needs_human");
          }
        }
      }
      await settle(ctx, open.map((d) => d.id));
      const stillOpen = ctx.repo.listDispatches({ findRequestId: request.id, states: ["reserved", "submission_unknown", "accepted", "terminal_unverified", "needs_human"] });
      if (stillOpen.length > 0) {
        return saveStatus(ctx, request, "needs_human");
      }
      request = applyFindObservations(ctx, request.id);
      continue;
    }
    // 2. Nothing in flight: decide the next wave from the ledger count.
    request = applyFindObservations(ctx, request.id);
    const wavesDispatched = ctx.repo.listDispatches({ findRequestId: request.id }).length;
    const { ranked } = candidatesFor(ctx, request, candidateOptions);
    const decision = nextWave(request, ranked, wavesDispatched);
    if (decision.action !== "dispatch") {
      return saveStatus(ctx, request, decision.action === "met" ? "met" : "exhausted");
    }
    const reserved: Dispatch = ctx.repo.reserveDispatch({
      id: newId("dsp"),
      kind: "find",
      watchId: request.watchId,
      findRequestId: request.id,
      sweepId: null,
      waveIndex: decision.waveIndex,
      idempotencyKey: findIdempotencyKey(request.id, decision.waveIndex),
      siteIds: decision.siteIds,
      taskText,
      schemaVersion: SCHEMA_VERSION,
      state: "reserved",
      callId: null,
      simulated: ctx.provider.mode === "fake",
      createdAt: ctx.now().toISOString(),
      submittedAt: null,
      terminalAt: null,
      note: null
    });
    request = { ...request, status: "running", usedSiteIds: [...new Set([...request.usedSiteIds, ...reserved.siteIds])], updatedAt: ctx.now().toISOString() };
    ctx.repo.saveFind(request);
    ctx.bus.emit({ type: "dispatch", dispatchId: reserved.id, state: reserved.state, callId: null, kind: "find", siteIds: reserved.siteIds, note: `wave ${decision.waveIndex + 1}` });
    ctx.bus.emit({ type: "find", findRequestId: request.id, status: request.status, confirmed: request.confirmedSiteIds.length, need: request.need });
    // Loop back: step 1 submits and settles the reservation through the same path as a recovery.
  }
}

export interface FindDescription {
  request: FindRequest;
  productLabel: string;
  waves: number;
  halt: { dispatchId: string; waveIndex: number | null; state: string; note: string | null } | null;
  confirmed: Array<{ siteId: string; name: string; phoneMasked: string; outcome: string; evidenceQuote: string; observedAt: string; holdResponse: string; quantityNote: string; restockExpectation: string; basis: "this_request" | "monitoring" }>;
  attempts: Array<{ siteId: string; name: string; outcome: string; usable: boolean; usableReason: string; evidenceQuote: string; waveIndex: number | null; observationId: string; dispatchId: string; recipientId: string; transcriptTurns: number }>;
}

export function describeFind(ctx: AppContext, request: FindRequest): FindDescription {
  const observations = ctx.repo.listObservations({ findRequestId: request.id });
  const dispatches = ctx.repo.listDispatches({ findRequestId: request.id });
  const waveOf = new Map(dispatches.map((d) => [d.id, d.waveIndex]));
  const stuck = dispatches.find((d) => d.state !== "terminal_verified");
  const halt = request.status === "needs_human" && stuck ? { dispatchId: stuck.id, waveIndex: stuck.waveIndex, state: stuck.state, note: stuck.note } : null;
  const confirmed = request.confirmedSiteIds.map((siteId) => {
    const site = ctx.repo.getSite(siteId);
    const own = observations.find((o) => o.siteId === siteId && o.usable && (o.outcome === "in_stock" || o.outcome === "limited"));
    const obs = own ?? latestForProduct(ctx, siteId, request.product, (o) => o.usable && (o.outcome === "in_stock" || o.outcome === "limited"));
    return {
      siteId,
      name: site?.name ?? siteId,
      phoneMasked: site ? maskPhone(site.phone) : "",
      outcome: obs?.outcome ?? "in_stock",
      evidenceQuote: obs?.evidenceQuote ?? "",
      observedAt: obs?.observedAt ?? request.updatedAt,
      holdResponse: obs?.holdResponse ?? "not_asked",
      quantityNote: obs?.quantityNote ?? "",
      restockExpectation: obs?.restockExpectation ?? "",
      basis: own ? ("this_request" as const) : ("monitoring" as const)
    };
  });
  return {
    request,
    productLabel: productLabel(request.product),
    waves: dispatches.length,
    halt,
    confirmed,
    attempts: observations.map((o) => ({
      siteId: o.siteId,
      name: ctx.repo.getSite(o.siteId)?.name ?? o.siteId,
      outcome: o.outcome,
      usable: o.usable,
      usableReason: o.usableReason,
      evidenceQuote: o.evidenceQuote,
      waveIndex: waveOf.get(o.dispatchId) ?? null,
      observationId: o.id,
      dispatchId: o.dispatchId,
      recipientId: o.recipientId,
      transcriptTurns: o.transcriptTurns
    }))
  };
}

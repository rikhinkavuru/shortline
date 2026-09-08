import { SCHEMA_VERSION, findIdempotencyKey, newId } from "../domain/ids.js";
import { maskPhone } from "../domain/phone.js";
import { buildTaskText, productLabel } from "../domain/task.js";
import { withinWindow } from "../domain/time.js";
import type { CallWindow, Dispatch, FindRequest, Product, Site } from "../domain/types.js";
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
}

export interface FindPreview {
  request: FindRequest;
  /** Sites already known in stock from surveillance within the last 24 hours; no call needed. */
  knownSources: Array<{ siteId: string; name: string; phoneMasked: string; observedAt: string; outcome: string; evidenceQuote: string }>;
  candidates: Array<{ siteId: string; name: string; phoneMasked: string; basis: string; distanceKm: number | null; kind: string }>;
  skipped: Array<{ siteId: string; name: string; reason: string }>;
  estimatedCalls: number;
}

const DEFAULT_WINDOW: CallWindow = { start: "09:00", end: "18:00", days: [1, 2, 3, 4, 5, 6] };
const KNOWN_FRESH_HOURS = 24;

function candidatesFor(ctx: AppContext, request: FindRequest, options: { ignoreWindow: boolean; window: CallWindow; near?: { lat: number; lng: number } }): { ranked: RankedCandidate[]; skipped: Array<{ site: Site; reason: string }> } {
  const now = ctx.now();
  const skipped: Array<{ site: Site; reason: string }> = [];
  const list: FindCandidate[] = [];
  for (const site of ctx.repo.listSites()) {
    if (site.region !== request.region) {
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
    } else if (!options.ignoreWindow && !withinWindow(site.timezone, options.window, now)) {
      ineligible = "outside_calling_window";
    }
    const latest = ctx.repo.listObservations({ siteId: site.id, limit: 1 })[0] ?? null;
    let recent: FindCandidate["recent"] = null;
    if (latest) {
      const ageHours = (now.getTime() - new Date(latest.observedAt).getTime()) / 3600000;
      if (latest.usable) {
        recent = { outcome: latest.outcome, observedAt: latest.observedAt, ageHours };
      } else if (ageHours < 24) {
        ineligible = ineligible ?? "called_in_last_24h";
      }
    }
    if (!ineligible && recent && recent.ageHours <= KNOWN_FRESH_HOURS && (recent.outcome === "in_stock" || recent.outcome === "limited")) {
      ineligible = "known_source_no_call_needed";
    }
    const distanceKm = options.near && site.lat !== undefined && site.lng !== undefined ? haversineKm(options.near, { lat: site.lat, lng: site.lng }) : null;
    const candidate: FindCandidate = { site, distanceKm, recent, ineligible };
    if (ineligible) {
      skipped.push({ site, reason: ineligible });
    }
    list.push(candidate);
  }
  const ranked = rankCandidates(list).filter((c) => c.basis !== "observed_out");
  for (const c of list) {
    if (!c.ineligible && c.recent && c.recent.ageHours <= 72 && c.recent.outcome === "out_of_stock") {
      skipped.push({ site: c.site, reason: "observed_out_of_stock_recently" });
    }
  }
  return { ranked, skipped };
}

export function planFind(ctx: AppContext, input: PlanFindInput): FindPreview {
  const watch = input.watchId ? ctx.repo.getWatch(input.watchId) : null;
  if (input.watchId && !watch) {
    throw new Error(`watch ${input.watchId} not found`);
  }
  const product = watch?.product ?? input.product;
  if (!product) {
    throw new Error("planFind: product or watchId is required");
  }
  const now = ctx.now().toISOString();
  const request: FindRequest = {
    id: newId("fnd"),
    watchId: watch?.id ?? null,
    product,
    region: input.region,
    need: Math.max(1, input.need ?? 2),
    waveSize: Math.max(1, Math.min(input.waveSize ?? 3, ctx.config.batchSize)),
    maxWaves: Math.max(1, input.maxWaves ?? 4),
    askHold: Boolean(input.askHold),
    status: "planned",
    plannedSiteIds: [],
    usedSiteIds: [],
    confirmedSiteIds: [],
    createdAt: now,
    updatedAt: now
  };
  const options: { ignoreWindow: boolean; window: CallWindow; near?: { lat: number; lng: number } } = {
    ignoreWindow: Boolean(input.ignoreWindow),
    window: input.window ?? watch?.window ?? DEFAULT_WINDOW
  };
  if (input.near) {
    options.near = input.near;
  }
  const { ranked, skipped } = candidatesFor(ctx, request, options);
  const knownSources: FindPreview["knownSources"] = [];
  for (const s of skipped) {
    if (s.reason === "known_source_no_call_needed") {
      const obs = ctx.repo.listObservations({ siteId: s.site.id, limit: 1 })[0];
      if (obs) {
        knownSources.push({ siteId: s.site.id, name: s.site.name, phoneMasked: maskPhone(s.site.phone), observedAt: obs.observedAt, outcome: obs.outcome, evidenceQuote: obs.evidenceQuote });
      }
    }
  }
  request.confirmedSiteIds = knownSources.map((k) => k.siteId);
  request.plannedSiteIds = ranked.slice(0, request.waveSize * request.maxWaves).map((c) => c.site.id);
  ctx.repo.saveFind(request);
  const remainingNeed = Math.max(0, request.need - request.confirmedSiteIds.length);
  const estimatedCalls = remainingNeed === 0 ? 0 : Math.min(request.plannedSiteIds.length, Math.max(request.waveSize, remainingNeed + 1));
  ctx.bus.emit({ type: "find", findRequestId: request.id, status: "planned", confirmed: request.confirmedSiteIds.length, need: request.need });
  return {
    request,
    knownSources,
    candidates: ranked.slice(0, request.waveSize * request.maxWaves).map((c) => ({ siteId: c.site.id, name: c.site.name, phoneMasked: maskPhone(c.site.phone), basis: c.basis, distanceKm: c.distanceKm === null ? null : Math.round(c.distanceKm * 10) / 10, kind: c.site.kind })),
    skipped: skipped.filter((s) => s.reason !== "known_source_no_call_needed").map((s) => ({ siteId: s.site.id, name: s.site.name, reason: s.reason })),
    estimatedCalls
  };
}

export interface RunFindOptions {
  /** Explicit confirmation that real calls may be placed. Required in every mode. */
  confirm: boolean;
  ignoreWindow?: boolean;
  window?: CallWindow;
  near?: { lat: number; lng: number };
}

/**
 * Run sourcing waves until the need is met, the candidate list is exhausted,
 * or the wave cap is reached. Each wave is one CALL-E call task with its
 * own idempotency key, so a crash mid-request never re-dials a wave.
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
  const watch = request.watchId ? ctx.repo.getWatch(request.watchId) : null;
  const candidateOptions: { ignoreWindow: boolean; window: CallWindow; near?: { lat: number; lng: number } } = {
    ignoreWindow: Boolean(options.ignoreWindow),
    window: options.window ?? watch?.window ?? DEFAULT_WINDOW
  };
  if (options.near) {
    candidateOptions.near = options.near;
  }
  const taskText = buildTaskText({ product: request.product, callerName: ctx.config.callerName, askHold: request.askHold, holdWindow: "today" });
  for (;;) {
    request = applyFindObservations(ctx, request.id);
    const { ranked } = candidatesFor(ctx, request, candidateOptions);
    const decision = nextWave(request, ranked);
    if (decision.action !== "dispatch") {
      const finished: FindRequest = { ...request, status: decision.action === "met" ? "met" : "exhausted", updatedAt: ctx.now().toISOString() };
      ctx.repo.saveFind(finished);
      ctx.bus.emit({ type: "find", findRequestId: finished.id, status: finished.status, confirmed: finished.confirmedSiteIds.length, need: finished.need });
      return finished;
    }
    const sites = decision.siteIds.map((id) => ctx.repo.getSite(id)).filter((s): s is Site => Boolean(s));
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
    request = { ...request, status: "running", usedSiteIds: [...new Set([...request.usedSiteIds, ...decision.siteIds])], updatedAt: ctx.now().toISOString() };
    ctx.repo.saveFind(request);
    ctx.bus.emit({ type: "dispatch", dispatchId: reserved.id, state: reserved.state, callId: null, kind: "find", siteIds: reserved.siteIds, note: `wave ${decision.waveIndex + 1}` });
    ctx.bus.emit({ type: "find", findRequestId: request.id, status: request.status, confirmed: request.confirmedSiteIds.length, need: request.need });
    const submitted = await submitDispatch(ctx, { dispatch: reserved, sites, product: request.product, askHold: request.askHold });
    if (submitted.state !== "accepted") {
      const halted: FindRequest = { ...request, status: "needs_human", updatedAt: ctx.now().toISOString() };
      ctx.repo.saveFind(halted);
      ctx.bus.emit({ type: "find", findRequestId: halted.id, status: halted.status, confirmed: halted.confirmedSiteIds.length, need: halted.need });
      return halted;
    }
    await settle(ctx, [submitted.id]);
    const verified = ctx.repo.getDispatch(submitted.id);
    if (!verified || verified.state !== "terminal_verified") {
      const halted: FindRequest = { ...request, status: "needs_human", updatedAt: ctx.now().toISOString() };
      ctx.repo.saveFind(halted);
      ctx.bus.emit({ type: "find", findRequestId: halted.id, status: halted.status, confirmed: halted.confirmedSiteIds.length, need: halted.need });
      return halted;
    }
  }
}

export function describeFind(ctx: AppContext, request: FindRequest): { request: FindRequest; productLabel: string; confirmed: Array<{ siteId: string; name: string; phoneMasked: string; outcome: string; evidenceQuote: string; observedAt: string; holdResponse: string; quantityNote: string; restockExpectation: string }>; attempts: Array<{ siteId: string; name: string; outcome: string; usable: boolean; usableReason: string; evidenceQuote: string; waveIndex: number | null }> } {
  const observations = ctx.repo.listObservations({ findRequestId: request.id });
  const dispatches = ctx.repo.listDispatches({ findRequestId: request.id });
  const waveOf = new Map(dispatches.map((d) => [d.id, d.waveIndex]));
  const confirmed = request.confirmedSiteIds.map((siteId) => {
    const site = ctx.repo.getSite(siteId);
    const obs = ctx.repo.listObservations({ siteId, limit: 5 }).find((o) => o.usable && (o.outcome === "in_stock" || o.outcome === "limited"));
    return {
      siteId,
      name: site?.name ?? siteId,
      phoneMasked: site ? maskPhone(site.phone) : "",
      outcome: obs?.outcome ?? "in_stock",
      evidenceQuote: obs?.evidenceQuote ?? "",
      observedAt: obs?.observedAt ?? request.updatedAt,
      holdResponse: obs?.holdResponse ?? "not_asked",
      quantityNote: obs?.quantityNote ?? "",
      restockExpectation: obs?.restockExpectation ?? ""
    };
  });
  return {
    request,
    productLabel: productLabel(request.product),
    confirmed,
    attempts: observations.map((o) => ({
      siteId: o.siteId,
      name: ctx.repo.getSite(o.siteId)?.name ?? o.siteId,
      outcome: o.outcome,
      usable: o.usable,
      usableReason: o.usableReason,
      evidenceQuote: o.evidenceQuote,
      waveIndex: waveOf.get(o.dispatchId) ?? null
    }))
  };
}

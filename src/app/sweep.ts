import { SCHEMA_VERSION, newId, sweepIdempotencyKey } from "../domain/ids.js";
import { type FrameEntry, dueNow, planSweep } from "../domain/sampling.js";
import { buildTaskText } from "../domain/task.js";
import { isoWeek as isoWeekOf } from "../domain/time.js";
import type { Dispatch, Site, Sweep, Watch } from "../domain/types.js";
import type { AppContext } from "./context.js";
import { submitDispatch } from "./dispatch.js";
import { recomputeEstimate } from "./estimate.js";
import { settle } from "./reconcile.js";

export interface SweepRunOptions {
  isoWeek?: string;
  /** Poll until every dispatch is terminal, then recompute the estimate. */
  wait?: boolean;
  /** Ignore local calling windows. Only for simulated history; refused in live mode. */
  force?: boolean;
}

export interface SweepRunSummary {
  sweep: Sweep;
  planned: number;
  alreadyDispatched: number;
  dispatchedNow: number;
  waitingForWindow: number;
  dispatchIds: string[];
  undersampled: string[];
  excluded: Array<{ siteId: string; reason: string }>;
}

export function frameFor(ctx: AppContext, watch: Watch): FrameEntry[] {
  return ctx.repo.listSites().map((site) => ({ site, history: ctx.repo.siteHistory(site.id, watch.id) }));
}

export function loadOrPlanSweep(ctx: AppContext, watch: Watch, isoWeek: string): { sweep: Sweep; excluded: Array<{ siteId: string; reason: string }> } {
  const existing = ctx.repo.getSweep(watch.id, isoWeek);
  const plan = planSweep(watch, frameFor(ctx, watch), isoWeek, ctx.now());
  if (existing) {
    return { sweep: existing, excluded: plan.excluded };
  }
  const sweep: Sweep = {
    id: newId("swp"),
    watchId: watch.id,
    isoWeek,
    plannedSiteIds: plan.plannedSiteIds,
    undersampledStrata: plan.undersampled,
    createdAt: ctx.now().toISOString(),
    status: "planned"
  };
  ctx.repo.saveSweep(sweep);
  ctx.bus.emit({ type: "sweep", sweepId: sweep.id, watchId: watch.id, isoWeek, status: "planned", note: `${sweep.plannedSiteIds.length} sites planned` });
  return { sweep, excluded: plan.excluded };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

/**
 * Dispatch the part of this week's plan that is inside its local calling
 * window right now. The host scheduler calls this several times a day; the
 * sweep row and per-batch idempotency keys make every call safe to repeat.
 */
export async function runSweep(ctx: AppContext, watch: Watch, options: SweepRunOptions = {}): Promise<SweepRunSummary> {
  if (watch.status !== "active") {
    throw new Error(`watch ${watch.id} is paused`);
  }
  if (options.force && ctx.config.mode === "live") {
    throw new Error("force is only allowed in dry-run mode");
  }
  const isoWeek = options.isoWeek ?? isoWeekOf(ctx.now());
  const { sweep, excluded } = loadOrPlanSweep(ctx, watch, isoWeek);
  const prior = ctx.repo.listDispatches({ sweepId: sweep.id });
  const already = new Set(prior.filter((d) => d.state !== "needs_human").flatMap((d) => d.siteIds));
  const remaining = sweep.plannedSiteIds
    .filter((id) => !already.has(id))
    .map((id) => ctx.repo.getSite(id))
    .filter((s): s is Site => s !== null && !s.optOut);
  const { due, waiting } = options.force ? { due: remaining, waiting: [] } : dueNow(remaining, watch.window, ctx.now());
  const dispatchIds: string[] = [];
  const retryable = prior.filter((d) => d.state === "reserved" || d.state === "submission_unknown");
  for (const d of retryable) {
    const sites = d.siteIds.map((id) => ctx.repo.getSite(id)).filter((s): s is Site => Boolean(s));
    const result = await submitDispatch(ctx, { dispatch: d, sites, product: watch.product, askHold: false });
    dispatchIds.push(result.id);
  }
  const taskText = buildTaskText({ product: watch.product, callerName: ctx.config.callerName, askHold: false });
  for (const batch of chunk(due, ctx.config.batchSize)) {
    const siteIds = batch.map((s) => s.id);
    const reserved: Dispatch = ctx.repo.reserveDispatch({
      id: newId("dsp"),
      kind: "sweep",
      watchId: watch.id,
      findRequestId: null,
      sweepId: sweep.id,
      waveIndex: null,
      idempotencyKey: sweepIdempotencyKey(watch.id, isoWeek, siteIds),
      siteIds,
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
    ctx.bus.emit({ type: "dispatch", dispatchId: reserved.id, state: reserved.state, callId: null, kind: "sweep", siteIds, note: null });
    const submitted = await submitDispatch(ctx, { dispatch: reserved, sites: batch, product: watch.product, askHold: false });
    dispatchIds.push(submitted.id);
  }
  if (sweep.status === "planned" && dispatchIds.length > 0) {
    ctx.repo.saveSweep({ ...sweep, status: "dispatching" });
  }
  if (options.wait && dispatchIds.length > 0) {
    await settle(ctx, dispatchIds);
    recomputeEstimate(ctx, watch.id, isoWeek);
  }
  const all = ctx.repo.listDispatches({ sweepId: sweep.id });
  const covered = new Set(all.filter((d) => d.state === "terminal_verified").flatMap((d) => d.siteIds));
  if (sweep.plannedSiteIds.every((id) => covered.has(id)) && all.length > 0) {
    ctx.repo.saveSweep({ ...sweep, status: "complete" });
    ctx.bus.emit({ type: "sweep", sweepId: sweep.id, watchId: watch.id, isoWeek, status: "complete", note: "all planned sites reconciled" });
  }
  return {
    sweep: ctx.repo.getSweep(watch.id, isoWeek) ?? sweep,
    planned: sweep.plannedSiteIds.length,
    alreadyDispatched: already.size,
    dispatchedNow: due.length,
    waitingForWindow: waiting.length,
    dispatchIds,
    undersampled: sweep.undersampledStrata,
    excluded
  };
}

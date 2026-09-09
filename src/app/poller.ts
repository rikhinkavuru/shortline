import { ProviderError } from "../calle/provider.js";
import type { Site } from "../domain/types.js";
import { emitNewCallEvents } from "./call-events.js";
import type { AppContext } from "./context.js";
import { submitDispatch } from "./dispatch.js";
import { reconcileDispatch } from "./reconcile.js";

export interface ReconcileSummary {
  reconciled: number;
  recovered: number;
  pending: number;
  /** True when CALL-E answered a read with rate_limit_exceeded; callers should back off. */
  rateLimited: boolean;
}

interface Flight {
  running: Promise<ReconcileSummary> | null;
  rerun: boolean;
}

const flights = new WeakMap<AppContext, Flight>();

async function reconcileOnce(ctx: AppContext): Promise<ReconcileSummary> {
  let reconciled = 0;
  let recovered = 0;
  let pending = 0;
  let rateLimited = false;
  const note = (message: string): void => ctx.bus.emit({ type: "notice", level: "warn", message });
  const guard = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ProviderError && error.code === "rate_limit_exceeded") {
        rateLimited = true;
      }
      note(`${label}: ${error instanceof Error ? error.message : String(error)}`);
      return fallback;
    }
  };
  for (const event of ctx.repo.pendingEvents()) {
    const dispatch = ctx.repo.getDispatchByCallId(event.callId);
    if (!dispatch) {
      ctx.repo.markEventProcessed(event.eventId, "no matching dispatch; ignored");
      continue;
    }
    const result = await guard(`reconcile ${dispatch.id}`, () => reconcileDispatch(ctx, dispatch), "pending" as const);
    if (result !== "pending") {
      ctx.repo.markEventProcessed(event.eventId, result);
    }
  }
  for (const dispatch of ctx.repo.listDispatches({ states: ["submission_unknown"] })) {
    const sites = dispatch.siteIds.map((id) => ctx.repo.getSite(id)).filter((s): s is Site => s !== null);
    const product = dispatch.watchId ? ctx.repo.getWatch(dispatch.watchId)?.product : ctx.repo.getFind(dispatch.findRequestId ?? "")?.product;
    if (!product) {
      continue;
    }
    const askHold = dispatch.findRequestId ? Boolean(ctx.repo.getFind(dispatch.findRequestId)?.askHold) : false;
    const result = await guard(`recover ${dispatch.id}`, () => submitDispatch(ctx, { dispatch, sites, product, askHold }), dispatch);
    if (result.state === "accepted") {
      recovered += 1;
    }
  }
  for (const dispatch of ctx.repo.listDispatches({ states: ["accepted", "terminal_unverified"] })) {
    if (dispatch.callId) {
      await emitNewCallEvents(ctx, dispatch.callId);
    }
    const result = await guard(`reconcile ${dispatch.id}`, () => reconcileDispatch(ctx, dispatch), "pending" as const);
    if (result === "pending") {
      pending += 1;
    } else {
      reconciled += 1;
    }
  }
  return { reconciled, recovered, pending, rateLimited };
}

/**
 * Recovery scan, single-flight per context. Safe to call from anywhere at any
 * time: concurrent callers share the in-progress run, and a call that arrives
 * mid-run schedules exactly one follow-up run so nothing is missed.
 */
export async function reconcilePending(ctx: AppContext): Promise<ReconcileSummary> {
  let flight = flights.get(ctx);
  if (!flight) {
    flight = { running: null, rerun: false };
    flights.set(ctx, flight);
  }
  if (flight.running) {
    flight.rerun = true;
    return flight.running;
  }
  const run = async (): Promise<ReconcileSummary> => {
    let summary = await reconcileOnce(ctx);
    while (flight.rerun) {
      flight.rerun = false;
      summary = await reconcileOnce(ctx);
    }
    return summary;
  };
  flight.running = run().finally(() => {
    flight.running = null;
  });
  return flight.running;
}

/** Poll on an interval, doubling the delay (up to 60 s) while CALL-E rate limits reads. */
export function startPolling(ctx: AppContext, intervalMs: number): () => void {
  let stopped = false;
  let delay = intervalMs;
  let timer: NodeJS.Timeout | null = null;
  const tick = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    const summary = await reconcilePending(ctx).catch(() => ({ reconciled: 0, recovered: 0, pending: 0, rateLimited: false }));
    if (ctx.config.keepTranscriptsDays > 0) {
      ctx.repo.purgeTranscriptsOlderThan(ctx.config.keepTranscriptsDays);
    }
    delay = summary.rateLimited ? Math.min(60000, delay * 2) : intervalMs;
    if (!stopped) {
      timer = setTimeout(() => void tick(), delay);
      timer.unref();
    }
  };
  void tick();
  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
    }
  };
}

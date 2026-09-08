import type { Site } from "../domain/types.js";
import type { AppContext } from "./context.js";
import { submitDispatch } from "./dispatch.js";
import { reconcileDispatch } from "./reconcile.js";

/**
 * Recovery scan. Safe to run at any time: it replays ambiguous submissions
 * with their original idempotency key, reconciles accepted dispatches, and
 * drains the webhook inbox by fetching the authoritative snapshot.
 */
export async function reconcilePending(ctx: AppContext): Promise<{ reconciled: number; recovered: number; pending: number }> {
  let reconciled = 0;
  let recovered = 0;
  let pending = 0;
  for (const event of ctx.repo.pendingEvents()) {
    const dispatch = ctx.repo.getDispatchByCallId(event.callId);
    if (!dispatch) {
      ctx.repo.markEventProcessed(event.eventId, "no matching dispatch; ignored");
      continue;
    }
    const result = await reconcileDispatch(ctx, dispatch).catch((error: Error) => {
      ctx.bus.emit({ type: "notice", level: "warn", message: `reconcile ${dispatch.id}: ${error.message}` });
      return "pending" as const;
    });
    if (result !== "pending") {
      ctx.repo.markEventProcessed(event.eventId, result);
    }
  }
  for (const dispatch of ctx.repo.listDispatches({ states: ["submission_unknown"] })) {
    const sites = dispatch.siteIds.map((id) => ctx.repo.getSite(id)).filter((s): s is Site => Boolean(s));
    const product = dispatch.watchId ? ctx.repo.getWatch(dispatch.watchId)?.product : ctx.repo.getFind(dispatch.findRequestId ?? "")?.product;
    if (!product) {
      continue;
    }
    const askHold = dispatch.findRequestId ? Boolean(ctx.repo.getFind(dispatch.findRequestId)?.askHold) : false;
    const result = await submitDispatch(ctx, { dispatch, sites, product, askHold }).catch(() => dispatch);
    if (result.state === "accepted") {
      recovered += 1;
    }
  }
  for (const dispatch of ctx.repo.listDispatches({ states: ["accepted", "terminal_unverified"] })) {
    if (dispatch.callId) {
      for (const e of await ctx.provider.listEvents(dispatch.callId).catch(() => [])) {
        ctx.bus.emit({ type: "call_event", callId: dispatch.callId, eventType: e.type, message: e.message, details: e.details });
      }
    }
    const result = await reconcileDispatch(ctx, dispatch).catch((error: Error) => {
      ctx.bus.emit({ type: "notice", level: "warn", message: `reconcile ${dispatch.id}: ${error.message}` });
      return "pending" as const;
    });
    if (result === "pending") {
      pending += 1;
    } else {
      reconciled += 1;
    }
  }
  return { reconciled, recovered, pending };
}

export function startPolling(ctx: AppContext, intervalMs: number): () => void {
  let stopped = false;
  let running = false;
  const tick = async (): Promise<void> => {
    if (stopped || running) {
      return;
    }
    running = true;
    try {
      await reconcilePending(ctx);
      if (ctx.config.keepTranscriptsDays > 0) {
        ctx.repo.purgeTranscriptsOlderThan(ctx.config.keepTranscriptsDays);
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

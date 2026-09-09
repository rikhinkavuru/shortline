import { type ProviderCall, type ProviderRecipient, isTerminal } from "../calle/provider.js";
import { type RecipientSnapshot, classifyRecipient } from "../domain/classify.js";
import { newId } from "../domain/ids.js";
import { maskDeep } from "../domain/phone.js";
import { isoWeek } from "../domain/time.js";
import type { Dispatch, Observation, Product, Site } from "../domain/types.js";
import type { AppContext } from "./context.js";
import { emitNewCallEvents, forgetCallEvents } from "./call-events.js";
import { recomputeEstimate } from "./estimate.js";
import { applyFindObservations } from "./find-state.js";

export type ReconcileResult = "pending" | "verified" | "needs_human" | "skipped";

function productFor(ctx: AppContext, dispatch: Dispatch): Product {
  if (dispatch.watchId) {
    const watch = ctx.repo.getWatch(dispatch.watchId);
    if (watch) {
      return watch.product;
    }
  }
  if (dispatch.findRequestId) {
    const find = ctx.repo.getFind(dispatch.findRequestId);
    if (find) {
      return find.product;
    }
  }
  throw new Error(`dispatch ${dispatch.id} has no product context`);
}

function snapshotOf(recipient: ProviderRecipient): RecipientSnapshot {
  const attempt = recipient.attempts[recipient.attempts.length - 1];
  return {
    recipientId: recipient.id,
    phone: recipient.phones[0] ?? "",
    status: recipient.status,
    structuredResult: recipient.structuredResult,
    transcript: (attempt?.transcriptTurns ?? []).map((t) => ({ speaker: t.speaker, text: t.text })),
    attemptFailureCode: attempt?.failureCode ?? null,
    attemptStarted: recipient.attempts.some((a) => a.startedAt !== null)
  };
}

function toObservation(ctx: AppContext, dispatch: Dispatch, call: ProviderCall, recipient: ProviderRecipient, site: Site, product: Product): Observation {
  const snap = snapshotOf(recipient);
  const c = classifyRecipient(product, snap, "strict");
  const attempt = recipient.attempts[recipient.attempts.length - 1];
  return {
    id: newId("obs"),
    watchId: dispatch.watchId,
    findRequestId: dispatch.findRequestId,
    siteId: site.id,
    dispatchId: dispatch.id,
    callId: call.id,
    recipientId: recipient.id,
    source: dispatch.kind,
    observedAt: attempt?.completedAt ?? call.completedAt ?? ctx.now().toISOString(),
    outcome: c.outcome,
    answeredBy: c.answeredBy,
    reachedPharmacy: c.reachedPharmacy,
    restockExpectation: c.restockExpectation,
    quantityNote: c.quantityNote,
    evidenceQuote: c.evidenceQuote,
    taskConfidenceScore: call.completionConfidence?.score ?? null,
    taskConfidenceLabel: call.completionConfidence?.label ?? null,
    doNotCallRequest: c.doNotCallRequest,
    holdResponse: c.holdResponse,
    usable: c.usable,
    usableReason: c.usableReason,
    simulated: dispatch.simulated,
    transcriptTurns: snap.transcript.length
  };
}

/**
 * Turn a terminal CALL-E snapshot into observations.
 *
 * The snapshot is always fetched with the API key, never trusted from a
 * webhook body. Before anything is recorded the call is bound back to the
 * dispatch (metadata id) and every recipient is bound to a site the
 * dispatch reserved (exact phone match). Anything else stops in
 * `needs_human` with the reason written down.
 */
export async function reconcileDispatch(ctx: AppContext, dispatch: Dispatch): Promise<ReconcileResult> {
  if (dispatch.state === "terminal_verified") {
    return "skipped";
  }
  if (!dispatch.callId) {
    return "pending";
  }
  const call = await ctx.provider.get(dispatch.callId);
  if (!isTerminal(call.status)) {
    return "pending";
  }
  let current = dispatch;
  if (current.state === "accepted" || current.state === "needs_human") {
    current = ctx.repo.transition(current.id, "terminal_unverified");
  }
  const stop = (note: string): ReconcileResult => {
    const halted = ctx.repo.transition(current.id, "needs_human", { note });
    ctx.bus.emit({ type: "dispatch", dispatchId: halted.id, state: halted.state, callId: halted.callId, kind: halted.kind, siteIds: halted.siteIds, note });
    return "needs_human";
  };
  if (call.metadata.dispatch_id !== current.id) {
    return stop(`binding mismatch: call metadata dispatch_id=${String(call.metadata.dispatch_id)}`);
  }
  const sites = current.siteIds.map((id) => ctx.repo.getSite(id)).filter((s): s is Site => Boolean(s));
  if (sites.length !== current.siteIds.length) {
    return stop("binding mismatch: a reserved site no longer exists");
  }
  const byPhone = new Map(sites.map((s) => [s.phone, s]));
  const product = productFor(ctx, current);
  const observations: Observation[] = [];
  for (const recipient of call.recipients) {
    const phone = recipient.phones[0] ?? "";
    const site = byPhone.get(phone);
    if (!site) {
      return stop(`binding mismatch: recipient ${recipient.id} does not match a reserved site`);
    }
    observations.push(toObservation(ctx, current, call, recipient, site, product));
  }
  const expected = call.structuredResult && typeof call.structuredResult.pharmacies_reached === "number" ? call.structuredResult.pharmacies_reached : null;
  const reached = observations.filter((o) => o.reachedPharmacy === "yes").length;
  let note: string | null = null;
  if (expected !== null && expected !== reached) {
    note = `task-level pharmacies_reached=${expected} disagrees with recipient results (${reached}); recipient results kept, flagged`;
    ctx.bus.emit({ type: "notice", level: "warn", message: `${current.id}: ${note}` });
  }
  for (const obs of observations) {
    const inserted = ctx.repo.insertObservation(obs);
    if (!inserted) {
      continue;
    }
    const site = sites.find((s) => s.id === obs.siteId);
    const recipient = call.recipients.find((r) => r.id === obs.recipientId);
    const turns = recipient?.attempts[recipient.attempts.length - 1]?.transcriptTurns ?? [];
    if (ctx.config.keepTranscriptsDays > 0 && turns.length > 0) {
      ctx.repo.saveTranscript(obs.dispatchId, obs.recipientId, obs.siteId, maskDeep(turns));
    }
    if (obs.doNotCallRequest) {
      ctx.repo.setOptOut(obs.siteId, true, `asked on call ${obs.callId}`);
    }
    if (obs.watchId) {
      if (obs.outcome === "not_carried") {
        ctx.repo.markCarries(obs.siteId, obs.watchId, false);
      }
      if (obs.outcome === "refused") {
        ctx.repo.markRefused(obs.siteId, obs.watchId, obs.observedAt);
      }
      if (obs.outcome === "not_reached") {
        const recent = ctx.repo.listObservations({ siteId: obs.siteId, limit: 2 });
        if (recent.length === 2 && recent.every((o) => o.outcome === "not_reached")) {
          ctx.repo.markWrongNumber(obs.siteId, obs.watchId);
        }
      }
    }
    ctx.bus.emit({
      type: "observation",
      observationId: obs.id,
      siteId: obs.siteId,
      siteName: site?.name ?? obs.siteId,
      outcome: obs.outcome,
      usable: obs.usable,
      usableReason: obs.usableReason,
      evidenceQuote: obs.evidenceQuote,
      source: obs.source,
      watchId: obs.watchId,
      findRequestId: obs.findRequestId
    });
  }
  if (current.callId) {
    await emitNewCallEvents(ctx, current.callId);
    forgetCallEvents(ctx, current.callId);
  }
  const verified = ctx.repo.transition(current.id, "terminal_verified", { note });
  ctx.bus.emit({ type: "dispatch", dispatchId: verified.id, state: verified.state, callId: verified.callId, kind: verified.kind, siteIds: verified.siteIds, note });
  if (verified.watchId && verified.sweepId) {
    const week = ctx.repo.listSweeps(verified.watchId).find((s) => s.id === verified.sweepId)?.isoWeek;
    recomputeEstimate(ctx, verified.watchId, week ?? isoWeek(new Date(observations[0]?.observedAt ?? ctx.now().toISOString())));
  }
  if (verified.findRequestId) {
    applyFindObservations(ctx, verified.findRequestId);
  }
  return "verified";
}

/** Poll a set of dispatches until every one is terminal and verified. */
export async function settle(ctx: AppContext, dispatchIds: string[], options: { intervalMs?: number; timeoutMs?: number } = {}): Promise<void> {
  const intervalMs = options.intervalMs ?? ctx.config.pollIntervalMs;
  const timeoutMs = options.timeoutMs ?? 20 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(dispatchIds);
  while (pending.size > 0) {
    for (const id of [...pending]) {
      const dispatch = ctx.repo.getDispatch(id);
      if (!dispatch) {
        pending.delete(id);
        continue;
      }
      if (dispatch.state === "terminal_verified" || dispatch.state === "needs_human" || dispatch.state === "submission_unknown" || dispatch.state === "reserved") {
        pending.delete(id);
        continue;
      }
      if (dispatch.callId) {
        await emitNewCallEvents(ctx, dispatch.callId);
      }
      let result: ReconcileResult = "pending";
      try {
        result = await reconcileDispatch(ctx, dispatch);
      } catch (error) {
        // A read failure (rate limit, transient network) must not abandon the wait; the dispatch stays accepted.
        ctx.bus.emit({ type: "notice", level: "warn", message: `reconcile ${dispatch.id}: ${error instanceof Error ? error.message : String(error)}; retrying` });
      }
      if (result !== "pending") {
        pending.delete(id);
      }
    }
    if (pending.size === 0) {
      break;
    }
    if (Date.now() > deadline) {
      throw new Error(`settle: timed out waiting for ${pending.size} dispatch(es); they remain accepted and will be reconciled later`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

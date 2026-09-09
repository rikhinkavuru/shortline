import type { AppContext } from "./context.js";
import { reconcilePending } from "./poller.js";

export interface WebhookOutcome {
  status: number;
  body: Record<string, unknown>;
}

/**
 * Durable receipt first, processing second. The body is never trusted for
 * a business decision: after the inbox row commits, the reconciler fetches
 * the call with the API key and compares. See docs/safety.md.
 */
export function handleWebhook(ctx: AppContext, rawBody: string, headerEventId: string | null): WebhookOutcome {
  let parsed: { id?: unknown; type?: unknown; data?: { id?: unknown } };
  try {
    parsed = JSON.parse(rawBody) as typeof parsed;
  } catch {
    return { status: 400, body: { error: "invalid_json" } };
  }
  if (typeof parsed.id !== "string" || typeof parsed.type !== "string" || typeof parsed.data?.id !== "string") {
    return { status: 400, body: { error: "invalid_event_shape" } };
  }
  if (!headerEventId || headerEventId !== parsed.id) {
    return { status: 400, body: { error: "invalid_event_id" } };
  }
  // Unknown call ids are not stored: the route is unauthenticated, and a call that
  // is not bound to one of our dispatches cannot wake anything useful. A delivery
  // that races the call-id binding is recovered by the next poll.
  if (!ctx.repo.getDispatchByCallId(parsed.data.id)) {
    return { status: 200, body: { ok: true, ignored: true } };
  }
  const outcome = ctx.repo.receiveEvent(parsed.id, parsed.data.id, parsed.type, rawBody);
  if (outcome === "conflict") {
    ctx.bus.emit({ type: "notice", level: "warn", message: `webhook ${parsed.id} redelivered with a different body; quarantined` });
    return { status: 200, body: { ok: true, quarantined: true } };
  }
  if (outcome === "inserted") {
    setImmediate(() => void reconcilePending(ctx));
  }
  return { status: 200, body: { ok: true, duplicate: outcome === "duplicate" } };
}

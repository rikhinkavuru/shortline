import type { AppContext } from "./context.js";

interface Tracker {
  cursor: string | null;
  seen: Set<string>;
}

const trackers = new WeakMap<AppContext, Map<string, Tracker>>();

function trackerFor(ctx: AppContext, callId: string): Tracker {
  let map = trackers.get(ctx);
  if (!map) {
    map = new Map();
    trackers.set(ctx, map);
  }
  let t = map.get(callId);
  if (!t) {
    t = { cursor: null, seen: new Set() };
    map.set(callId, t);
  }
  return t;
}

/**
 * Read developer events for a call from the retained cursor and emit only the
 * ones not seen before, so a dashboard feed shows each CALL-E event once even
 * though the poller and a waiting command both look at the same call.
 */
export async function emitNewCallEvents(ctx: AppContext, callId: string): Promise<number> {
  const t = trackerFor(ctx, callId);
  let emitted = 0;
  try {
    const page = await ctx.provider.listEventsAfter(callId, t.cursor);
    for (const e of page.events) {
      if (t.seen.has(e.id)) {
        continue;
      }
      t.seen.add(e.id);
      emitted += 1;
      ctx.bus.emit({ type: "call_event", callId, eventId: e.id, eventType: e.type, message: e.message, details: e.details });
    }
    if (page.nextCursor) {
      t.cursor = page.nextCursor;
    }
  } catch (error) {
    ctx.bus.emit({ type: "notice", level: "warn", message: `events for ${callId}: ${error instanceof Error ? error.message : String(error)}` });
  }
  return emitted;
}

export function forgetCallEvents(ctx: AppContext, callId: string): void {
  trackers.get(ctx)?.delete(callId);
}

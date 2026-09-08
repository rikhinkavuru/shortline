import type { FindRequest } from "../domain/types.js";
import type { AppContext } from "./context.js";

/** Fold verified observations for a sourcing request back into its state. */
export function applyFindObservations(ctx: AppContext, requestId: string): FindRequest {
  const request = ctx.repo.getFind(requestId);
  if (!request) {
    throw new Error(`find request ${requestId} not found`);
  }
  const confirmed = new Set(request.confirmedSiteIds);
  for (const obs of ctx.repo.listObservations({ findRequestId: requestId })) {
    if (obs.usable && (obs.outcome === "in_stock" || obs.outcome === "limited")) {
      confirmed.add(obs.siteId);
    }
  }
  const next: FindRequest = { ...request, confirmedSiteIds: [...confirmed], updatedAt: ctx.now().toISOString() };
  ctx.repo.saveFind(next);
  ctx.bus.emit({ type: "find", findRequestId: next.id, status: next.status, confirmed: next.confirmedSiteIds.length, need: next.need });
  return next;
}

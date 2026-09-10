import { maskPhone } from "../domain/phone.js";
import { isoWeek, localClock, withinWindow } from "../domain/time.js";
import type { AppContext } from "../app/context.js";
import { describeFind, sitesInFlight } from "../app/find.js";

/** Everything the dashboard needs, with every phone number masked. */
export function snapshotState(ctx: AppContext, watchId: string | null): Record<string, unknown> {
  const watches = ctx.repo.listWatches();
  const watch = (watchId ? ctx.repo.getWatch(watchId) : null) ?? watches[0] ?? null;
  const week = isoWeek(ctx.now());
  const sites = ctx.repo.listSites().map((s) => {
    const last = ctx.repo.listObservations({ siteId: s.id, limit: 1 })[0] ?? null;
    const since = new Date(ctx.now().getTime() - 30 * 86400000).toISOString();
    const callsThisMonth = ctx.repo.listObservations({ siteId: s.id, since }).length;
    const history = watch ? ctx.repo.siteHistory(s.id, watch.id) : null;
    return {
      id: s.id,
      name: s.name,
      kind: s.kind,
      region: s.region,
      timezone: s.timezone,
      phoneMasked: maskPhone(s.phone),
      optOut: s.optOut,
      optOutReason: s.optOutReason ?? null,
      testLine: Boolean(s.testLine),
      lastOutcome: last?.outcome ?? null,
      lastObservedAt: last?.observedAt ?? null,
      callsThisMonth,
      carries: history?.carries ?? true,
      refusedAt: history?.refusedAt ? history.refusedAt.toISOString() : null,
      lat: s.lat ?? null,
      lng: s.lng ?? null
    };
  });
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const observations = ctx.repo.listObservations(watch ? { watchId: watch.id, limit: 60 } : { limit: 60 }).map((o) => ({
    ...o,
    siteName: siteName.get(o.siteId) ?? o.siteId
  }));
  const dispatches = (watch ? ctx.repo.listDispatches({ watchId: watch.id }) : ctx.repo.listDispatches()).slice(0, 30).map((d) => ({
    id: d.id,
    kind: d.kind,
    state: d.state,
    callId: d.callId,
    siteIds: d.siteIds,
    siteNames: d.siteIds.map((id) => siteName.get(id) ?? id),
    waveIndex: d.waveIndex,
    sweepId: d.sweepId,
    findRequestId: d.findRequestId,
    createdAt: d.createdAt,
    submittedAt: d.submittedAt,
    terminalAt: d.terminalAt,
    note: d.note,
    simulated: d.simulated
  }));
  const sweep = watch ? ctx.repo.getSweep(watch.id, week) : null;
  const sweepDispatches = sweep ? ctx.repo.listDispatches({ sweepId: sweep.id }) : [];
  const dispatchedSites = new Set(sweepDispatches.filter((d) => d.state !== "needs_human" || d.callId !== null).flatMap((d) => d.siteIds));
  const verifiedSites = new Set(sweepDispatches.filter((d) => d.state === "terminal_verified").flatMap((d) => d.siteIds));
  const inFlight = sitesInFlight(ctx);
  const now = ctx.now();
  const waitingForWindow = sweep && watch
    ? sweep.plannedSiteIds.filter((id) => {
        const s = ctx.repo.getSite(id);
        return s && !s.optOut && !s.testLine && !dispatchedSites.has(id) && !withinWindow(s.timezone, watch.window, now);
      }).length
    : 0;
  const firstZone = sites.find((s) => watch?.regions.includes(s.region))?.timezone ?? null;
  const localNow = firstZone ? { timezone: firstZone, ...localClock(firstZone, now) } : null;
  return {
    mode: ctx.config.mode,
    now: ctx.now().toISOString(),
    localNow,
    window: watch?.window ?? null,
    week,
    callerName: ctx.config.callerName,
    operatorName: ctx.config.operatorName,
    watches: watches.map((w) => ({ id: w.id, product: w.product, status: w.status, regions: w.regions })),
    watch,
    estimates: watch ? ctx.repo.listEstimates(watch.id) : [],
    sweep: sweep
      ? {
          id: sweep.id,
          isoWeek: sweep.isoWeek,
          status: sweep.status,
          planned: sweep.plannedSiteIds.length,
          dispatched: dispatchedSites.size,
          verified: verifiedSites.size,
          waitingForWindow,
          inFlight: sweep.plannedSiteIds.filter((id) => inFlight.has(id) && !dispatchedSites.has(id)).length,
          needsHuman: sweepDispatches.filter((d) => d.state === "needs_human").length,
          undersampled: sweep.undersampledStrata,
          plannedSites: sweep.plannedSiteIds.map((id) => ({ id, name: siteName.get(id) ?? id, dispatched: dispatchedSites.has(id), verified: verifiedSites.has(id) }))
        }
      : null,
    dispatches,
    observations,
    sites,
    finds: ctx.repo
      .listFinds(12)
      .filter((f) => f.status !== "planned" && !(f.status === "stopped" && f.usedSiteIds.length === 0))
      .slice(0, 6)
      .map((f) => describeFind(ctx, f)),
    audit: ctx.repo.listAudit(40),
    events: ctx.bus.history(150)
  };
}

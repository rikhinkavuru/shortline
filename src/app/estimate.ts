import { type StratumCounts, buildEstimate } from "../domain/estimator.js";
import { stratumKey } from "../domain/ids.js";
import { isoWeekStart } from "../domain/time.js";
import type { Estimate, Observation, SiteKind } from "../domain/types.js";
import type { AppContext } from "./context.js";

/** Latest observation per site inside the week, so a re-dial never double counts. */
function latestPerSite(observations: Observation[]): Map<string, Observation> {
  const out = new Map<string, Observation>();
  for (const obs of observations) {
    const current = out.get(obs.siteId);
    if (!current || obs.observedAt > current.observedAt) {
      out.set(obs.siteId, obs);
    }
  }
  return out;
}

export function recomputeEstimate(ctx: AppContext, watchId: string, isoWeek: string): Estimate {
  const watch = ctx.repo.getWatch(watchId);
  if (!watch) {
    throw new Error(`watch ${watchId} not found`);
  }
  const start = isoWeekStart(isoWeek);
  const end = new Date(start.getTime() + 7 * 86400000);
  const sites = ctx.repo.listSites().filter((s) => watch.regions.includes(s.region) && !s.testLine);
  const counts = new Map<string, StratumCounts>();
  const ensure = (region: string, kind: SiteKind): StratumCounts => {
    const key = stratumKey(region, kind);
    let entry = counts.get(key);
    if (!entry) {
      entry = { stratum: key, region, kind, frameSize: 0, planned: 0, usable: 0, available: 0, inStock: 0, limited: 0 };
      counts.set(key, entry);
    }
    return entry;
  };
  const siteById = new Map(sites.map((s) => [s.id, s]));
  for (const site of sites) {
    const history = ctx.repo.siteHistory(site.id, watchId);
    if (!site.optOut && history.carries && !history.wrongNumber) {
      ensure(site.region, site.kind).frameSize += 1;
    }
  }
  const sweep = ctx.repo.getSweep(watchId, isoWeek);
  if (sweep) {
    for (const id of sweep.plannedSiteIds) {
      const site = siteById.get(id);
      if (site) {
        ensure(site.region, site.kind).planned += 1;
      }
    }
  }
  // Only sweep observations enter the index. Sourcing calls are outcome-selected
  // (they dial sites ranked by prior stock and stop at the first successes), so
  // pooling them would mask exactly the shortage the index exists to detect.
  const weekObs = ctx.repo
    .listObservations({ watchId, since: start.toISOString() })
    .filter((o) => o.source === "sweep" && o.usable && o.observedAt < end.toISOString());
  let simulated = false;
  for (const obs of latestPerSite(weekObs).values()) {
    const site = siteById.get(obs.siteId);
    if (!site || !obs.usable) {
      continue;
    }
    simulated = simulated || obs.simulated;
    const entry = ensure(site.region, site.kind);
    entry.usable += 1;
    if (obs.outcome === "in_stock") {
      entry.inStock += 1;
      entry.available += 1;
    } else if (obs.outcome === "limited") {
      entry.limited += 1;
      entry.available += 1;
    }
  }
  const estimate = buildEstimate({
    watchId,
    isoWeek,
    computedAt: ctx.now(),
    strata: [...counts.values()].sort((a, b) => a.stratum.localeCompare(b.stratum)),
    minUsable: watch.minUsable,
    thresholds: watch.thresholds,
    simulated
  });
  ctx.repo.saveEstimate(estimate);
  ctx.bus.emit({ type: "estimate", watchId, isoWeek, signal: estimate.signal, pHat: estimate.overall.pHat });
  return estimate;
}

import type { FindRequest, ObservationOutcome, Site } from "./types.js";

export interface FindCandidate {
  site: Site;
  distanceKm: number | null;
  /** Most recent usable observation for this product at this site, if any. */
  recent: { outcome: ObservationOutcome; observedAt: string; ageHours: number } | null;
  ineligible: string | null;
}

export interface RankedCandidate extends FindCandidate {
  score: number;
  basis: "observed_in_stock" | "unknown" | "observed_out";
}

const FRESH_HOURS = 72;

/**
 * Rank candidates for a sourcing wave. Fresh surveillance observations feed
 * the ranking: a site seen in stock this week goes first, a site seen out of
 * stock this week goes last, and everything else is ordered by distance.
 */
export function rankCandidates(candidates: FindCandidate[]): RankedCandidate[] {
  const ranked: RankedCandidate[] = [];
  for (const c of candidates) {
    if (c.ineligible) {
      continue;
    }
    let score = 0;
    let basis: RankedCandidate["basis"] = "unknown";
    if (c.recent && c.recent.ageHours <= FRESH_HOURS) {
      if (c.recent.outcome === "in_stock" || c.recent.outcome === "limited") {
        score += 1000 - c.recent.ageHours;
        basis = "observed_in_stock";
      } else if (c.recent.outcome === "out_of_stock") {
        score -= 1000;
        basis = "observed_out";
      }
    }
    if (c.distanceKm !== null) {
      score -= c.distanceKm;
    }
    ranked.push({ ...c, score, basis });
  }
  return ranked.sort((a, b) => b.score - a.score || a.site.name.localeCompare(b.site.name));
}

export interface WaveDecision {
  action: "dispatch" | "met" | "exhausted";
  siteIds: string[];
  waveIndex: number;
}

/**
 * Decide the next wave. Stops the moment the need is met, never re-dials a
 * site inside the same request, and refuses to exceed `maxWaves`.
 */
export function nextWave(request: FindRequest, ranked: RankedCandidate[]): WaveDecision {
  const waveIndex = request.usedSiteIds.length === 0 ? 0 : Math.ceil(request.usedSiteIds.length / request.waveSize);
  if (request.confirmedSiteIds.length >= request.need) {
    return { action: "met", siteIds: [], waveIndex };
  }
  if (waveIndex >= request.maxWaves) {
    return { action: "exhausted", siteIds: [], waveIndex };
  }
  const used = new Set(request.usedSiteIds);
  const remainingNeed = request.need - request.confirmedSiteIds.length;
  const size = Math.max(1, Math.min(request.waveSize, remainingNeed + 1));
  const siteIds = ranked
    .filter((c) => !used.has(c.site.id))
    .slice(0, size)
    .map((c) => c.site.id);
  if (siteIds.length === 0) {
    return { action: "exhausted", siteIds: [], waveIndex };
  }
  return { action: "dispatch", siteIds, waveIndex };
}

export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number): number => (d * Math.PI) / 180;
  const r = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

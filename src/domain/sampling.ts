import { stratumKey } from "./ids.js";
import { seededShuffle } from "./random.js";
import { daysBetween, isoWeek, isoWeeksBetween, withinWindow } from "./time.js";
import type { Site, Watch } from "./types.js";

export interface SiteHistory {
  /** Last Shortline call to this site for this watch, any outcome. */
  lastAskedForWatch: Date | null;
  /** Last Shortline call to this site for any purpose. */
  lastCalledAny: Date | null;
  /** Site said it does not carry the product; excluded from the frame. */
  carries: boolean;
  /** Site refused to disclose stock; long cooldown applies. */
  refusedAt: Date | null;
  /** Number was wrong or not a pharmacy. */
  wrongNumber: boolean;
}

export interface EligibilityInput {
  site: Site;
  watch: Watch;
  history: SiteHistory;
  now: Date;
  refusalCooldownDays?: number;
}

export type Ineligibility =
  | "test_line"
  | "opted_out"
  | "region_not_watched"
  | "does_not_carry"
  | "wrong_number"
  | "refused_recently"
  | "watch_cooldown"
  | "global_gap";

/** Why a site may not be sampled right now. `null` means eligible. */
export function ineligibility(input: EligibilityInput): Ineligibility | null {
  const { site, watch, history, now } = input;
  if (site.testLine) {
    return "test_line";
  }
  if (site.optOut) {
    return "opted_out";
  }
  if (!watch.regions.includes(site.region)) {
    return "region_not_watched";
  }
  if (!history.carries) {
    return "does_not_carry";
  }
  if (history.wrongNumber) {
    return "wrong_number";
  }
  const refusalDays = input.refusalCooldownDays ?? 90;
  if (history.refusedAt && daysBetween(history.refusedAt, now) < refusalDays) {
    return "refused_recently";
  }
  // Cooldown is counted in ISO weeks so a weekly cron that fires a few minutes
  // early never sees the whole panel as "asked 13.99 days ago" and plans nothing.
  if (history.lastAskedForWatch && isoWeeksBetween(isoWeek(history.lastAskedForWatch), isoWeek(now)) < Math.ceil(watch.cooldownDays / 7)) {
    return "watch_cooldown";
  }
  if (history.lastCalledAny && daysBetween(history.lastCalledAny, now) < watch.globalMinGapDays) {
    return "global_gap";
  }
  return null;
}

export interface FrameEntry {
  site: Site;
  history: SiteHistory;
}

export interface SweepPlan {
  seed: string;
  /** Sites chosen for this sweep, grouped by stratum, in dispatch order. */
  bySite: Map<string, Site[]>;
  plannedSiteIds: string[];
  /** Strata whose eligible pool was smaller than the target. */
  undersampled: string[];
  /** Frame size per stratum (sites believed to carry the product, not opted out). */
  frameSizes: Map<string, number>;
  excluded: Array<{ siteId: string; reason: Ineligibility }>;
}

/**
 * Plan one sweep: a fresh random subsample per stratum, drawn only from
 * sites that are eligible today. Courtesy is a property of the design —
 * the cooldown makes the panel rotate, so no site is asked about the same
 * product more than once per `cooldownDays`.
 */
export function planSweep(watch: Watch, frame: FrameEntry[], isoWeek: string, now: Date): SweepPlan {
  const seed = `${watch.id}:${isoWeek}`;
  const eligibleByStratum = new Map<string, Site[]>();
  const frameSizes = new Map<string, number>();
  const excluded: Array<{ siteId: string; reason: Ineligibility }> = [];
  for (const entry of frame) {
    const key = stratumKey(entry.site.region, entry.site.kind);
    if (watch.regions.includes(entry.site.region) && !entry.site.optOut && !entry.site.testLine && entry.history.carries && !entry.history.wrongNumber) {
      frameSizes.set(key, (frameSizes.get(key) ?? 0) + 1);
    }
    const reason = ineligibility({ site: entry.site, watch, history: entry.history, now });
    if (reason) {
      excluded.push({ siteId: entry.site.id, reason });
      continue;
    }
    const list = eligibleByStratum.get(key) ?? [];
    list.push(entry.site);
    eligibleByStratum.set(key, list);
  }
  const bySite = new Map<string, Site[]>();
  const undersampled: string[] = [];
  const plannedSiteIds: string[] = [];
  for (const key of [...frameSizes.keys()].sort()) {
    const pool = seededShuffle(eligibleByStratum.get(key) ?? [], `${seed}:${key}`);
    const chosen = pool.slice(0, watch.panelPerStratum);
    if (chosen.length < watch.panelPerStratum) {
      undersampled.push(key);
    }
    bySite.set(key, chosen);
    for (const site of chosen) {
      plannedSiteIds.push(site.id);
    }
  }
  return { seed, bySite, plannedSiteIds, undersampled, frameSizes, excluded };
}

/** Sites from a plan that can be dialled right now under their local window. */
export function dueNow(sites: Site[], window: Watch["window"], now: Date): { due: Site[]; waiting: Site[] } {
  const due: Site[] = [];
  const waiting: Site[] = [];
  for (const site of sites) {
    if (site.testLine || withinWindow(site.timezone, window, now)) {
      due.push(site);
    } else {
      waiting.push(site);
    }
  }
  return { due, waiting };
}

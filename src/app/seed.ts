import { readFileSync } from "node:fs";
import { FakeCalleProvider } from "../calle/fake.js";
import { mixUnderPressure } from "../calle/scenarios.js";
import { assertE164 } from "../domain/phone.js";
import { isValidTimezone, isoWeek } from "../domain/time.js";
import type { Site, Watch } from "../domain/types.js";
import { type AppContext, setClock } from "./context.js";
import { runSweep } from "./sweep.js";

interface SiteFixture {
  id: string;
  name: string;
  kind: Site["kind"];
  phone: string;
  region: string;
  timezone: string;
  lat?: number;
  lng?: number;
  scenario?: string;
}

interface WatchFixture extends Omit<Watch, "createdAt"> {}

export function loadSites(ctx: AppContext, path: string, sourceRef = path): number {
  const raw = JSON.parse(readFileSync(path, "utf8")) as SiteFixture[];
  let count = 0;
  for (const f of raw) {
    assertE164(f.phone, `fixture ${f.id}`);
    if (!isValidTimezone(f.timezone)) {
      throw new Error(`fixture ${f.id}: invalid timezone ${f.timezone}`);
    }
    const existing = ctx.repo.getSite(f.id);
    const site: Site = {
      id: f.id,
      name: f.name,
      kind: f.kind,
      phone: f.phone,
      region: f.region,
      timezone: f.timezone,
      source: { kind: "fixture", ref: sourceRef },
      optOut: existing?.optOut ?? false,
      createdAt: existing?.createdAt ?? ctx.now().toISOString()
    };
    if (f.lat !== undefined) {
      site.lat = f.lat;
    }
    if (f.lng !== undefined) {
      site.lng = f.lng;
    }
    if (f.scenario) {
      site.scenario = f.scenario;
    }
    ctx.repo.upsertSite(site);
    count += 1;
  }
  return count;
}

export function loadWatches(ctx: AppContext, path: string): number {
  const raw = JSON.parse(readFileSync(path, "utf8")) as WatchFixture[];
  for (const f of raw) {
    const existing = ctx.repo.getWatch(f.id);
    ctx.repo.upsertWatch({ ...f, createdAt: existing?.createdAt ?? ctx.now().toISOString() });
  }
  return raw.length;
}

/**
 * Simulate past sweeps in dry-run mode so the dashboard opens with a trend.
 * Each simulated week is dispatched with the clock set to a Wednesday
 * mid-morning in the sites' zone and a rising shortage pressure. Every
 * observation is stored with `simulated = true`.
 */
export async function simulateHistory(ctx: AppContext, watchId: string, weeks: number, options: { finalPressure?: number } = {}): Promise<string[]> {
  if (ctx.provider.mode !== "fake") {
    throw new Error("simulateHistory only runs against the fake provider");
  }
  const watch = ctx.repo.getWatch(watchId);
  if (!watch) {
    throw new Error(`watch ${watchId} not found`);
  }
  const fake = ctx.provider as FakeCalleProvider;
  const realNow = ctx.now();
  const done: string[] = [];
  const finalPressure = options.finalPressure ?? 1.0;
  try {
    for (let back = weeks; back >= 1; back -= 1) {
      // Same weekday and time as now, `back` weeks earlier, so cooldowns line
      // up with a real sweep run today: the panel asked two weeks ago is due
      // again, last week's panel is still resting.
      const at = new Date(realNow.getTime() - back * 7 * 86400000);
      const week = isoWeek(at);
      setClock(ctx, () => at);
      const progress = (weeks - back) / Math.max(1, weeks - 1);
      fake.mix = mixUnderPressure(0.1 + (finalPressure - 0.1) * progress);
      await runSweep(ctx, watch, { isoWeek: week, wait: true, force: true });
      done.push(week);
    }
  } finally {
    setClock(ctx, () => new Date());
    fake.mix = mixUnderPressure(finalPressure);
  }
  return done;
}

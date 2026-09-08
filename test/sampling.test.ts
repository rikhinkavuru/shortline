import { describe, expect, it } from "vitest";
import { dueNow, ineligibility, planSweep } from "../src/domain/sampling.js";
import type { Site, Watch } from "../src/domain/types.js";

const watch: Watch = {
  id: "w1",
  product: { name: "amoxicillin" },
  regions: ["US-CA-SF"],
  panelPerStratum: 2,
  cooldownDays: 14,
  globalMinGapDays: 5,
  window: { start: "10:00", end: "17:00", days: [1, 2, 3, 4, 5, 6] },
  thresholds: { shortageUpper: 0.5, strainedPoint: 0.7 },
  minUsable: 6,
  status: "active",
  createdAt: "2026-07-01T00:00:00Z"
};

const site = (id: string, over: Partial<Site> = {}): Site => ({
  id,
  name: id,
  kind: "independent",
  phone: `+1415555010${id.slice(-1)}`,
  region: "US-CA-SF",
  timezone: "America/Los_Angeles",
  source: { kind: "fixture", ref: "test" },
  optOut: false,
  createdAt: "2026-07-01T00:00:00Z",
  ...over
});

const fresh = { lastAskedForWatch: null, lastCalledAny: null, carries: true, refusedAt: null, wrongNumber: false };
const now = new Date("2026-09-07T18:00:00Z");

describe("ineligibility", () => {
  it("is null for a fresh site", () => {
    expect(ineligibility({ site: site("s1"), watch, history: fresh, now })).toBeNull();
  });
  it("respects opt-out above everything else", () => {
    expect(ineligibility({ site: site("s1", { optOut: true }), watch, history: fresh, now })).toBe("opted_out");
  });
  it("applies the per-watch cooldown and the global gap", () => {
    const tenDaysAgo = new Date(now.getTime() - 10 * 86400000);
    expect(ineligibility({ site: site("s1"), watch, history: { ...fresh, lastAskedForWatch: tenDaysAgo }, now })).toBe("watch_cooldown");
    const twoDaysAgo = new Date(now.getTime() - 2 * 86400000);
    expect(ineligibility({ site: site("s1"), watch, history: { ...fresh, lastCalledAny: twoDaysAgo }, now })).toBe("global_gap");
    const fifteenDaysAgo = new Date(now.getTime() - 15 * 86400000);
    expect(ineligibility({ site: site("s1"), watch, history: { ...fresh, lastAskedForWatch: fifteenDaysAgo, lastCalledAny: fifteenDaysAgo }, now })).toBeNull();
  });
  it("rests a site that refused for ninety days and drops one that does not carry the product", () => {
    expect(ineligibility({ site: site("s1"), watch, history: { ...fresh, refusedAt: new Date(now.getTime() - 30 * 86400000) }, now })).toBe("refused_recently");
    expect(ineligibility({ site: site("s1"), watch, history: { ...fresh, carries: false }, now })).toBe("does_not_carry");
  });
});

describe("planSweep", () => {
  const frame = [1, 2, 3, 4, 5].map((n) => ({ site: site(`s${n}`), history: fresh }));
  it("is deterministic for the same watch and week and differs across weeks", () => {
    const a = planSweep(watch, frame, "2026-W36", now);
    const b = planSweep(watch, frame, "2026-W36", now);
    const c = planSweep(watch, frame, "2026-W37", now);
    expect(a.plannedSiteIds).toEqual(b.plannedSiteIds);
    expect(a.plannedSiteIds).toHaveLength(2);
    expect(c.plannedSiteIds).toHaveLength(2);
    expect([...a.plannedSiteIds, ...c.plannedSiteIds].length).toBeGreaterThan(new Set(a.plannedSiteIds).size);
  });
  it("counts the frame without opted-out or non-carrying sites and flags undersampling", () => {
    const small = [
      { site: site("s1"), history: fresh },
      { site: site("s2", { optOut: true }), history: fresh },
      { site: site("s3"), history: { ...fresh, carries: false } }
    ];
    const plan = planSweep(watch, small, "2026-W36", now);
    expect(plan.frameSizes.get("US-CA-SF|independent")).toBe(1);
    expect(plan.plannedSiteIds).toEqual(["s1"]);
    expect(plan.undersampled).toEqual(["US-CA-SF|independent"]);
    expect(plan.excluded.map((e) => e.reason).sort()).toEqual(["does_not_carry", "opted_out"]);
  });
});

describe("dueNow", () => {
  it("splits sites by their own local calling window", () => {
    // 18:00Z is 11:00 in Los Angeles (inside) and 14:00 in New York (inside); 02:00Z is outside both.
    const la = site("s1");
    const ny = site("s2", { timezone: "America/New_York" });
    const inside = dueNow([la, ny], watch.window, new Date("2026-09-08T18:00:00Z"));
    expect(inside.due.map((s) => s.id)).toEqual(["s1", "s2"]);
    const outside = dueNow([la, ny], watch.window, new Date("2026-09-08T02:00:00Z"));
    expect(outside.due).toHaveLength(0);
    expect(outside.waiting).toHaveLength(2);
  });
  it("refuses Sundays when the window excludes them", () => {
    const sunday = new Date("2026-09-06T18:00:00Z");
    expect(dueNow([site("s1")], watch.window, sunday).due).toHaveLength(0);
  });
});

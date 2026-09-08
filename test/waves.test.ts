import { describe, expect, it } from "vitest";
import type { FindRequest, Site } from "../src/domain/types.js";
import { haversineKm, nextWave, rankCandidates } from "../src/domain/waves.js";

const site = (id: string): Site => ({
  id,
  name: id,
  kind: "independent",
  phone: `+1415555010${id.slice(-1)}`,
  region: "US-CA-SF",
  timezone: "America/Los_Angeles",
  source: { kind: "fixture", ref: "t" },
  optOut: false,
  createdAt: "2026-07-01T00:00:00Z"
});

const request = (over: Partial<FindRequest> = {}): FindRequest => ({
  id: "fnd_1",
  watchId: null,
  product: { name: "amoxicillin" },
  region: "US-CA-SF",
  need: 2,
  waveSize: 3,
  maxWaves: 3,
  askHold: false,
  status: "planned",
  plannedSiteIds: [],
  usedSiteIds: [],
  confirmedSiteIds: [],
  createdAt: "2026-09-07T00:00:00Z",
  updatedAt: "2026-09-07T00:00:00Z",
  ...over
});

describe("rankCandidates", () => {
  it("puts fresh in-stock sightings first, fresh out-of-stock last, then nearest", () => {
    const ranked = rankCandidates([
      { site: site("far"), distanceKm: 20, recent: null, ineligible: null },
      { site: site("near"), distanceKm: 2, recent: null, ineligible: null },
      { site: site("seen"), distanceKm: 30, recent: { outcome: "in_stock", observedAt: "", ageHours: 40 }, ineligible: null },
      { site: site("out"), distanceKm: 1, recent: { outcome: "out_of_stock", observedAt: "", ageHours: 10 }, ineligible: null },
      { site: site("optd"), distanceKm: 0, recent: null, ineligible: "opted_out" }
    ]);
    expect(ranked.map((r) => r.site.id)).toEqual(["seen", "near", "far", "out"]);
    expect(ranked[0]?.basis).toBe("observed_in_stock");
    expect(ranked[3]?.basis).toBe("observed_out");
  });
});

describe("nextWave", () => {
  const ranked = rankCandidates(["a", "b", "c", "d", "e"].map((id) => ({ site: site(id), distanceKm: null, recent: null, ineligible: null })));
  it("dispatches need+1 sites on the first wave and never re-dials a used site", () => {
    const first = nextWave(request(), ranked);
    expect(first).toEqual({ action: "dispatch", siteIds: ["a", "b", "c"], waveIndex: 0 });
    const second = nextWave(request({ usedSiteIds: ["a", "b", "c"], confirmedSiteIds: ["a"] }), ranked);
    expect(second.action).toBe("dispatch");
    expect(second.waveIndex).toBe(1);
    expect(second.siteIds).toEqual(["d", "e"]);
  });
  it("stops the moment the need is met", () => {
    expect(nextWave(request({ usedSiteIds: ["a", "b", "c"], confirmedSiteIds: ["a", "b"] }), ranked).action).toBe("met");
  });
  it("stops at the wave cap and when candidates run out", () => {
    expect(nextWave(request({ maxWaves: 1, usedSiteIds: ["a", "b", "c"] }), ranked).action).toBe("exhausted");
    expect(nextWave(request({ usedSiteIds: ["a", "b", "c", "d", "e"] }), ranked).action).toBe("exhausted");
  });
});

describe("haversineKm", () => {
  it("measures San Francisco to Oakland at roughly thirteen kilometres", () => {
    expect(haversineKm({ lat: 37.7749, lng: -122.4194 }, { lat: 37.8044, lng: -122.2712 })).toBeCloseTo(13.4, 0);
  });
});

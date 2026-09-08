import { describe, expect, it } from "vitest";
import { FakeCalleProvider } from "../src/calle/fake.js";
import { type CallProvider, type CreateBatchInput, ProviderError } from "../src/calle/provider.js";
import { loadConfig } from "../src/app/config.js";
import { createContext, setClock, type AppContext } from "../src/app/context.js";
import { planFind, runFind } from "../src/app/find.js";
import { reconcilePending } from "../src/app/poller.js";
import { reconcileDispatch } from "../src/app/reconcile.js";
import { loadSites, loadWatches, simulateHistory } from "../src/app/seed.js";
import { runSweep } from "../src/app/sweep.js";
import { handleWebhook } from "../src/app/webhook.js";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";

function makeCtx(provider?: CallProvider, env: Record<string, string> = {}): AppContext {
  const config = loadConfig({ SHORTLINE_DB: ":memory:", ...env });
  const repo = new Repo(openDb(":memory:"));
  const ctx = createContext({ config, repo, ...(provider ? { provider } : {}) });
  if (!provider) {
    ctx.provider = new FakeCalleProvider({ speed: "instant", resolver: (phone) => repo.getSiteByPhone(phone)?.scenario, clock: () => ctx.now() });
  }
  loadSites(ctx, "fixtures/sites.sample.json");
  loadWatches(ctx, "fixtures/watches.sample.json");
  return ctx;
}

const WEDNESDAY_11_LA = new Date("2026-09-09T18:00:00Z");

describe("sweep workflow (dry-run)", () => {
  it("plans, dispatches, reconciles, and produces an estimate; a second run is a no-op", async () => {
    const ctx = makeCtx();
    setClock(ctx, () => WEDNESDAY_11_LA);
    const watch = ctx.repo.getWatch("amoxicillin-susp")!;
    const first = await runSweep(ctx, watch, { wait: true });
    expect(first.planned).toBe(18);
    expect(first.dispatchedNow).toBe(18);
    expect(first.waitingForWindow).toBe(0);
    expect(first.sweep.status).toBe("complete");
    const estimates = ctx.repo.listEstimates(watch.id);
    expect(estimates).toHaveLength(1);
    expect(estimates[0]?.planned).toBe(18);
    expect(estimates[0]?.simulated).toBe(true);
    const second = await runSweep(ctx, watch, { wait: true });
    expect(second.dispatchedNow).toBe(0);
    expect(ctx.repo.listDispatches()).toHaveLength(first.dispatchIds.length);
  });
  it("holds sites outside their calling window and dispatches them later", async () => {
    const ctx = makeCtx();
    setClock(ctx, () => new Date("2026-09-09T03:00:00Z")); // 20:00 in Los Angeles
    const watch = ctx.repo.getWatch("amoxicillin-susp")!;
    const late = await runSweep(ctx, watch, { wait: true });
    expect(late.dispatchedNow).toBe(0);
    expect(late.waitingForWindow).toBe(18);
    setClock(ctx, () => WEDNESDAY_11_LA);
    const morning = await runSweep(ctx, watch, { wait: true });
    expect(morning.dispatchedNow).toBe(18);
  });
  it("honours a do-not-call request forever and drops wrong numbers from the frame", async () => {
    const ctx = makeCtx();
    setClock(ctx, () => WEDNESDAY_11_LA);
    const watch = ctx.repo.getWatch("amoxicillin-susp")!;
    await simulateHistory(ctx, watch.id, 4);
    const optedOut = ctx.repo.listSites().filter((s) => s.optOut);
    expect(optedOut.map((s) => s.id)).toContain("sf-ind-4");
    for (const d of ctx.repo.listDispatches()) {
      expect(d.siteIds.filter((id) => id === "sf-ind-4").length).toBeLessThanOrEqual(1);
    }
    const bad = ctx.repo.siteHistory("sj-ind-5", watch.id);
    expect(bad.wrongNumber).toBe(true);
    expect(ctx.repo.listEstimates(watch.id)).toHaveLength(4);
  });
});

describe("crash safety", () => {
  it("records submission_unknown on an ambiguous create and recovers with the same key", async () => {
    const fake = new FakeCalleProvider({ speed: "instant", resolver: () => "in_stock_human" });
    let failNext = true;
    const flaky: CallProvider = {
      mode: "fake",
      async create(input: CreateBatchInput, key: string) {
        if (failNext) {
          failNext = false;
          // The request may or may not have reached CALL-E: simulate that it did.
          await fake.create(input, key);
          throw new ProviderError({ code: "transport_ambiguous", message: "socket hang up", retrySafe: false, callStarted: "unknown" });
        }
        return fake.create(input, key);
      },
      get: (id) => fake.get(id),
      listEvents: (id) => fake.listEvents(id)
    };
    const ctx = makeCtx(flaky);
    setClock(ctx, () => WEDNESDAY_11_LA);
    const watch = ctx.repo.getWatch("amoxicillin-susp")!;
    const run = await runSweep(ctx, watch, { wait: false });
    const states = ctx.repo.listDispatches().map((d) => d.state);
    expect(states).toContain("submission_unknown");
    expect(run.dispatchIds.length).toBeGreaterThan(1);
    const recovered = await reconcilePending(ctx);
    expect(recovered.recovered).toBe(1);
    await reconcilePending(ctx);
    expect(ctx.repo.listDispatches().every((d) => d.state === "terminal_verified")).toBe(true);
    expect(fake.size).toBe(run.dispatchIds.length);
  });
  it("stops in needs_human when the call is not bound to the dispatch", async () => {
    const fake = new FakeCalleProvider({ speed: "instant", resolver: () => "in_stock_human" });
    const ctx = makeCtx(fake);
    setClock(ctx, () => WEDNESDAY_11_LA);
    const watch = ctx.repo.getWatch("amoxicillin-susp")!;
    const run = await runSweep(ctx, watch, { wait: false });
    const dispatch = ctx.repo.getDispatch(run.dispatchIds[0]!)!;
    const foreign = await fake.create({ task: "x", recipients: [{ phone: "+14155550199" }], recipientResultSchema: {}, metadata: { dispatch_id: "someone_else" } }, "foreign");
    const swapped = ctx.repo.transition(dispatch.id, "accepted", { callId: foreign.id });
    expect(await reconcileDispatch(ctx, swapped)).toBe("needs_human");
    expect(ctx.repo.getDispatch(dispatch.id)?.note).toMatch(/binding mismatch/);
    expect(ctx.repo.listObservations({ dispatchId: dispatch.id })).toHaveLength(0);
  });
});

describe("find workflow (dry-run)", () => {
  it("plans without calling, then runs waves until the need is met", async () => {
    const ctx = makeCtx();
    setClock(ctx, () => WEDNESDAY_11_LA);
    const preview = planFind(ctx, { watchId: "amoxicillin-susp", region: "US-CA-SF", need: 2, waveSize: 3, maxWaves: 4 });
    expect(preview.request.status).toBe("planned");
    expect(preview.candidates.length).toBeGreaterThan(0);
    expect(preview.estimatedCalls).toBe(3);
    expect(ctx.repo.listDispatches()).toHaveLength(0);
    await expect(runFind(ctx, preview.request.id, { confirm: false })).rejects.toThrow(/confirm/);
    const result = await runFind(ctx, preview.request.id, { confirm: true });
    expect(["met", "exhausted"]).toContain(result.status);
    expect(result.confirmedSiteIds.length).toBeGreaterThanOrEqual(result.status === "met" ? 2 : 0);
    const dispatches = ctx.repo.listDispatches({ findRequestId: result.id });
    expect(new Set(dispatches.flatMap((d) => d.siteIds)).size).toBe(dispatches.flatMap((d) => d.siteIds).length);
  });
  it("reuses a fresh surveillance sighting instead of dialling again", async () => {
    const ctx = makeCtx();
    setClock(ctx, () => WEDNESDAY_11_LA);
    const watch = ctx.repo.getWatch("amoxicillin-susp")!;
    await runSweep(ctx, watch, { wait: true });
    const preview = planFind(ctx, { watchId: watch.id, region: "US-CA-SF", need: 1 });
    const known = preview.knownSources.length;
    if (known > 0) {
      expect(preview.estimatedCalls).toBe(0);
      expect(preview.request.confirmedSiteIds).toHaveLength(known);
    }
    const askedToday = ctx.repo.listObservations({ watchId: watch.id }).map((o) => o.siteId);
    expect(preview.candidates.every((c) => !askedToday.includes(c.siteId))).toBe(true);
  });
});

describe("live-mode guards", () => {
  it("refuses to start live mode without the key and the acknowledgement", () => {
    expect(() => loadConfig({ SHORTLINE_MODE: "live" })).toThrow(/CALLE_API_KEY/);
    expect(() => loadConfig({ SHORTLINE_MODE: "live", CALLE_API_KEY: "iams_live_x" })).toThrow(/SHORTLINE_LIVE_ACK/);
  });
  it("refuses to dial fiction-reserved numbers in live mode", async () => {
    const config = loadConfig({ SHORTLINE_MODE: "live", CALLE_API_KEY: "iams_live_x", SHORTLINE_LIVE_ACK: "I_UNDERSTAND_REAL_CALLS_COST_MONEY_AND_CANNOT_BE_RECALLED", SHORTLINE_DB: ":memory:" });
    const repo = new Repo(openDb(":memory:"));
    const fake = new FakeCalleProvider({ speed: "instant" });
    const ctx = createContext({ config, repo, provider: fake });
    loadSites(ctx, "fixtures/sites.sample.json");
    loadWatches(ctx, "fixtures/watches.sample.json");
    setClock(ctx, () => WEDNESDAY_11_LA);
    const watch = ctx.repo.getWatch("amoxicillin-susp")!;
    await expect(runSweep(ctx, watch, { wait: false })).rejects.toThrow(/fiction-reserved/);
    expect(fake.size).toBe(0);
    await expect(runSweep(ctx, watch, { force: true })).rejects.toThrow(/dry-run/);
  });
});

describe("webhook receiver", () => {
  it("rejects malformed bodies and mismatched event ids, and dedupes redelivery", () => {
    const ctx = makeCtx();
    expect(handleWebhook(ctx, "not json", "evt_1").status).toBe(400);
    expect(handleWebhook(ctx, JSON.stringify({ id: "evt_1", type: "call.completed", data: { id: "call_1" } }), null).status).toBe(400);
    expect(handleWebhook(ctx, JSON.stringify({ id: "evt_1", type: "call.completed", data: { id: "call_1" } }), "evt_other").status).toBe(400);
    const body = JSON.stringify({ id: "evt_1", type: "call.completed", data: { id: "call_1" } });
    expect(handleWebhook(ctx, body, "evt_1")).toEqual({ status: 200, body: { ok: true, duplicate: false } });
    expect(handleWebhook(ctx, body, "evt_1")).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(handleWebhook(ctx, JSON.stringify({ id: "evt_1", type: "call.completed", data: { id: "call_2" } }), "evt_1").body).toMatchObject({ quarantined: true });
  });
});

describe("operator test lines", () => {
  it("are never sampled or estimated, but can be targeted by a sourcing request at any hour", async () => {
    const ctx = makeCtx();
    setClock(ctx, () => new Date("2026-09-09T03:00:00Z")); // 20:00 in Los Angeles, outside the window
    ctx.repo.upsertSite({
      id: "demo-me",
      name: "Corner Pharmacy (test line)",
      kind: "independent",
      phone: "+14155550190",
      region: "US-CA-SF",
      timezone: "America/Los_Angeles",
      source: { kind: "manual", ref: "test" },
      optOut: false,
      testLine: true,
      scenario: "limited_human",
      createdAt: "2026-09-01T00:00:00Z"
    });
    const watch = ctx.repo.getWatch("amoxicillin-susp")!;
    const sweep = await runSweep(ctx, watch, { wait: true, force: true });
    expect(sweep.sweep.plannedSiteIds).not.toContain("demo-me");
    expect(sweep.excluded.find((e) => e.siteId === "demo-me")?.reason).toBe("test_line");
    const preview = planFind(ctx, { watchId: watch.id, region: "US-CA-SF", need: 1, waveSize: 1, maxWaves: 1, onlySiteIds: ["demo-me"] });
    expect(preview.candidates.map((c) => c.siteId)).toEqual(["demo-me"]);
    expect(preview.estimatedCalls).toBe(1);
    const result = await runFind(ctx, preview.request.id, { confirm: true });
    expect(result.status).toBe("met");
    expect(result.confirmedSiteIds).toEqual(["demo-me"]);
    const estimate = ctx.repo.listEstimates(watch.id).at(-1)!;
    expect(estimate.strata.every((s) => s.frameSize <= 6)).toBe(true);
    const obs = ctx.repo.listObservations({ siteId: "demo-me" });
    expect(obs).toHaveLength(1);
    expect(obs[0]?.outcome).toBe("limited");
  });
});

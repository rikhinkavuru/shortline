import { describe, expect, it } from "vitest";
import { FakeCalleProvider } from "../src/calle/fake.js";
import { type CallProvider, type CreateBatchInput, ProviderError } from "../src/calle/provider.js";
import { loadConfig } from "../src/app/config.js";
import { createContext, setClock, type AppContext } from "../src/app/context.js";
import { planFind, runFind } from "../src/app/find.js";
import { reconcilePending } from "../src/app/poller.js";
import { reconcileDispatch, settle } from "../src/app/reconcile.js";
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
    expect(preview.firstWaveCalls).toBe(3);
    expect(preview.maxCalls).toBe(preview.candidates.length);
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
  it("refuses to start live mode without the key, the acknowledgement, and a disclosed caller name", () => {
    expect(() => loadConfig({ SHORTLINE_MODE: "live" })).toThrow(/CALLE_API_KEY/);
    expect(() => loadConfig({ SHORTLINE_MODE: "live", CALLE_API_KEY: "iams_live_x" })).toThrow(/SHORTLINE_LIVE_ACK/);
    expect(() => loadConfig({ SHORTLINE_MODE: "live", CALLE_API_KEY: "iams_live_x", SHORTLINE_LIVE_ACK: "I_UNDERSTAND_REAL_CALLS_COST_MONEY_AND_CANNOT_BE_RECALLED" })).toThrow(/SHORTLINE_CALLER_NAME/);
  });
  it("refuses to ignore calling hours in live mode, before any candidate is planned", async () => {
    const config = loadConfig({ SHORTLINE_MODE: "live", CALLE_API_KEY: "iams_live_x", SHORTLINE_LIVE_ACK: "I_UNDERSTAND_REAL_CALLS_COST_MONEY_AND_CANNOT_BE_RECALLED", SHORTLINE_CALLER_NAME: "Shortline", SHORTLINE_DB: ":memory:" });
    const fake = new FakeCalleProvider({ speed: "instant" });
    const ctx = createContext({ config, repo: new Repo(openDb(":memory:")), provider: fake });
    loadSites(ctx, "fixtures/sites.sample.json");
    loadWatches(ctx, "fixtures/watches.sample.json");
    setClock(ctx, () => new Date("2026-09-09T03:00:00Z"));
    expect(() => planFind(ctx, { watchId: "amoxicillin-susp", region: "US-CA-SF", ignoreWindow: true })).toThrow(/dry-run/);
    const preview = planFind(ctx, { watchId: "amoxicillin-susp", region: "US-CA-SF" });
    await expect(runFind(ctx, preview.request.id, { confirm: true, ignoreWindow: true })).rejects.toThrow(/dry-run/);
    expect(fake.size).toBe(0);
  });
  it("refuses to dial fiction-reserved numbers in live mode", async () => {
    const config = loadConfig({ SHORTLINE_MODE: "live", CALLE_API_KEY: "iams_live_x", SHORTLINE_LIVE_ACK: "I_UNDERSTAND_REAL_CALLS_COST_MONEY_AND_CANNOT_BE_RECALLED", SHORTLINE_CALLER_NAME: "Shortline", SHORTLINE_DB: ":memory:" });
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
  it("rejects malformed bodies and mismatched event ids, ignores unknown calls, and dedupes redelivery", () => {
    const ctx = makeCtx();
    // Bind a dispatch to call_1 so deliveries for it are accepted; anything else is ignored, never stored.
    ctx.repo.reserveDispatch({
      id: "dsp_hook",
      kind: "sweep",
      watchId: "amoxicillin-susp",
      findRequestId: null,
      sweepId: "swp_hook",
      waveIndex: null,
      idempotencyKey: "sweep:hook:v1",
      siteIds: ["sf-ind-1"],
      taskText: "t",
      schemaVersion: "v1",
      state: "reserved",
      callId: null,
      simulated: true,
      createdAt: "2026-09-07T00:00:00Z",
      submittedAt: null,
      terminalAt: null,
      note: null
    });
    ctx.repo.transition("dsp_hook", "accepted", { callId: "call_1" });
    expect(handleWebhook(ctx, JSON.stringify({ id: "evt_0", type: "call.completed", data: { id: "call_unknown" } }), "evt_0")).toEqual({ status: 200, body: { ok: true, ignored: true } });
    expect(ctx.repo.pendingEvents()).toHaveLength(0);
    expect(handleWebhook(ctx, "not json", "evt_1").status).toBe(400);
    expect(handleWebhook(ctx, JSON.stringify({ id: "evt_1", type: "call.completed", data: { id: "call_1" } }), null).status).toBe(400);
    expect(handleWebhook(ctx, JSON.stringify({ id: "evt_1", type: "call.completed", data: { id: "call_1" } }), "evt_other").status).toBe(400);
    const body = JSON.stringify({ id: "evt_1", type: "call.completed", data: { id: "call_1" } });
    expect(handleWebhook(ctx, body, "evt_1")).toEqual({ status: 200, body: { ok: true, duplicate: false } });
    expect(handleWebhook(ctx, body, "evt_1")).toEqual({ status: 200, body: { ok: true, duplicate: true } });
    expect(handleWebhook(ctx, JSON.stringify({ id: "evt_1", type: "call.failed", data: { id: "call_1" } }), "evt_1").body).toMatchObject({ quarantined: true });
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


describe("find loop robustness", () => {
  it("numbers waves from the ledger: need=1 with every pharmacy out runs to exhaustion with unique keys", async () => {
    const fake = new FakeCalleProvider({ speed: "instant", resolver: () => "out_of_stock_human" });
    const ctx = makeCtx(fake);
    setClock(ctx, () => WEDNESDAY_11_LA);
    const preview = planFind(ctx, { watchId: "amoxicillin-susp", region: "US-CA-SF", need: 1, waveSize: 3, maxWaves: 4 });
    const result = await runFind(ctx, preview.request.id, { confirm: true });
    expect(result.status).toBe("exhausted");
    const dispatches = ctx.repo.listDispatches({ findRequestId: result.id });
    expect(dispatches).toHaveLength(4);
    expect(new Set(dispatches.map((d) => d.idempotencyKey)).size).toBe(4);
    expect(dispatches.every((d) => d.state === "terminal_verified")).toBe(true);
    expect(new Set(result.usedSiteIds)).toEqual(new Set(dispatches.flatMap((d) => d.siteIds)));
  });
  it("re-submits a wave that hit a retry-safe error under its original key before planning a new one", async () => {
    const fake = new FakeCalleProvider({ speed: "instant", resolver: () => "in_stock_human" });
    let failOnce = true;
    const flaky: CallProvider = {
      mode: "fake",
      async create(input: CreateBatchInput, key: string) {
        if (failOnce) {
          failOnce = false;
          throw new ProviderError({ code: "rate_limit_exceeded", message: "slow down", status: 429, retrySafe: true, callStarted: false });
        }
        return fake.create(input, key);
      },
      get: (id) => fake.get(id),
      listEvents: (id, after) => fake.listEvents(id, after),
      listEventsAfter: (id, after) => fake.listEventsAfter(id, after)
    };
    const ctx = makeCtx(flaky);
    setClock(ctx, () => WEDNESDAY_11_LA);
    const preview = planFind(ctx, { watchId: "amoxicillin-susp", region: "US-CA-SF", need: 1, waveSize: 2 });
    await expect(runFind(ctx, preview.request.id, { confirm: true })).rejects.toThrow(/slow down/);
    const reserved = ctx.repo.listDispatches({ findRequestId: preview.request.id });
    expect(reserved).toHaveLength(1);
    expect(reserved[0]?.state).toBe("reserved");
    const result = await runFind(ctx, preview.request.id, { confirm: true });
    expect(result.status).toBe("met");
    const dispatches = ctx.repo.listDispatches({ findRequestId: result.id });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.idempotencyKey).toBe(reserved[0]?.idempotencyKey);
    expect(fake.size).toBe(1);
  });
  it("never dials a site whose sweep call is still in flight", async () => {
    const fake = new FakeCalleProvider({ speed: { queueMs: 50, ringMs: 50, talkMs: 200 }, resolver: () => "in_stock_human" });
    const ctx = makeCtx(fake);
    setClock(ctx, () => WEDNESDAY_11_LA);
    const watch = ctx.repo.getWatch("amoxicillin-susp")!;
    const sweep = await runSweep(ctx, watch, { wait: false });
    const inFlight = new Set(sweep.dispatchIds.flatMap((id) => ctx.repo.getDispatch(id)?.siteIds ?? []));
    const preview = planFind(ctx, { watchId: watch.id, region: "US-CA-SF", need: 2 });
    expect(preview.candidates.every((c) => !inFlight.has(c.siteId))).toBe(true);
    expect(preview.skipped.some((s) => s.reason === "call_in_flight")).toBe(true);
    fake.settleAll();
    await settle(ctx, sweep.dispatchIds);
  });
});

describe("index integrity", () => {
  it("keeps sourcing calls out of the weekly index", async () => {
    const fake = new FakeCalleProvider({ speed: "instant", resolver: (phone) => (phone.endsWith("6") ? "in_stock_human" : "out_of_stock_human") });
    const ctx = makeCtx(fake);
    setClock(ctx, () => WEDNESDAY_11_LA);
    const watch = ctx.repo.getWatch("amoxicillin-susp")!;
    await runSweep(ctx, watch, { wait: true });
    const before = ctx.repo.listEstimates(watch.id).at(-1)!;
    setClock(ctx, () => new Date(WEDNESDAY_11_LA.getTime() + 26 * 3600000));
    const preview = planFind(ctx, { watchId: watch.id, region: "US-CA-SF", need: 3, waveSize: 3, maxWaves: 3 });
    await runFind(ctx, preview.request.id, { confirm: true });
    const after = ctx.repo.listEstimates(watch.id).at(-1)!;
    expect(after.usable).toBe(before.usable);
    expect(after.planned).toBe(before.planned);
    expect(after.overall.pHat).toBe(before.overall.pHat);
    expect(after.responseRate ?? 0).toBeLessThanOrEqual(1);
    expect(ctx.repo.listObservations({ findRequestId: preview.request.id }).length).toBeGreaterThan(0);
  });
  it("scopes known sources and out-of-stock skips to the product asked about", async () => {
    const fake = new FakeCalleProvider({ speed: "instant", resolver: () => "in_stock_human" });
    const ctx = makeCtx(fake);
    setClock(ctx, () => WEDNESDAY_11_LA);
    const watch = ctx.repo.getWatch("amoxicillin-susp")!;
    await runSweep(ctx, watch, { wait: true });
    setClock(ctx, () => new Date(WEDNESDAY_11_LA.getTime() + 3600000));
    const same = planFind(ctx, { watchId: watch.id, region: "US-CA-SF", need: 1 });
    expect(same.knownSources.length).toBeGreaterThan(0);
    expect(same.firstWaveCalls).toBe(0);
    const other = ctx.repo.getWatch("methylphenidate-er")!;
    const different = planFind(ctx, { watchId: other.id, region: "US-CA-SF", need: 1 });
    expect(different.knownSources).toHaveLength(0);
    expect(different.request.confirmedSiteIds).toHaveLength(0);
    const swept = new Set(ctx.repo.listObservations({ watchId: watch.id }).map((o) => o.siteId));
    expect(different.skipped.filter((s) => swept.has(s.siteId)).every((s) => s.reason === "called_in_last_24h")).toBe(true);
  });
});

describe("callee opt-out is protected", () => {
  it("cannot be reversed by an operator without an explicit override", async () => {
    const ctx = makeCtx();
    setClock(ctx, () => WEDNESDAY_11_LA);
    const watch = ctx.repo.getWatch("amoxicillin-susp")!;
    await simulateHistory(ctx, watch.id, 2);
    const site = ctx.repo.getSite("sf-ind-4")!;
    expect(site.optOut).toBe(true);
    expect(site.optOutReason).toMatch(/^asked on call /);
    const denied = ctx.repo.setOptOut(site.id, false, "dashboard");
    expect(denied.ok).toBe(false);
    expect(ctx.repo.getSite(site.id)?.optOut).toBe(true);
    expect(ctx.repo.getSite(site.id)?.optOutReason).toBe(site.optOutReason);
    expect(ctx.repo.setOptOut(site.id, true, "operator").ok).toBe(true);
    expect(ctx.repo.getSite(site.id)?.optOutReason).toBe(site.optOutReason);
    expect(ctx.repo.setOptOut(site.id, false, "withdrawn in writing", { overrideCallee: true }).ok).toBe(true);
    expect(ctx.repo.getSite(site.id)?.optOut).toBe(false);
  });
});

describe("demo history", () => {
  it("is reproducible and ends worse than it started", async () => {
    const run = async () => {
      const ctx = makeCtx();
      setClock(ctx, () => WEDNESDAY_11_LA);
      const watch = ctx.repo.getWatch("amoxicillin-susp")!;
      await simulateHistory(ctx, watch.id, 8);
      return ctx.repo.listEstimates(watch.id);
    };
    const a = await run();
    const b = await run();
    expect(a.map((e) => [e.isoWeek, e.usable, e.overall.pHat])).toEqual(b.map((e) => [e.isoWeek, e.usable, e.overall.pHat]));
    expect(a).toHaveLength(8);
    const first = a[0]!;
    const last = a[a.length - 1]!;
    expect(first.signal).toBe("available");
    expect(["strained", "shortage"]).toContain(last.signal);
    expect(last.overall.pHat!).toBeLessThan(first.overall.pHat!);
  });
});

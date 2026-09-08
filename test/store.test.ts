import { describe, expect, it } from "vitest";
import { openDb } from "../src/store/db.js";
import { Repo } from "../src/store/repo.js";
import type { Dispatch } from "../src/domain/types.js";

function repo(): Repo {
  return new Repo(openDb(":memory:"));
}

const dispatch = (over: Partial<Dispatch> = {}): Dispatch => ({
  id: "dsp_1",
  kind: "sweep",
  watchId: "w",
  findRequestId: null,
  sweepId: "swp",
  waveIndex: null,
  idempotencyKey: "sweep:w:2026-W37:abc:v1",
  siteIds: ["s1", "s2"],
  taskText: "task",
  schemaVersion: "v1",
  state: "reserved",
  callId: null,
  simulated: true,
  createdAt: "2026-09-07T00:00:00Z",
  submittedAt: null,
  terminalAt: null,
  note: null,
  ...over
});

describe("dispatch ledger", () => {
  it("reserves once per idempotency key and returns the existing row on replay", () => {
    const r = repo();
    const first = r.reserveDispatch(dispatch());
    const again = r.reserveDispatch(dispatch({ id: "dsp_other" }));
    expect(again.id).toBe(first.id);
    expect(r.listDispatches()).toHaveLength(1);
  });
  it("walks reserved -> accepted -> terminal_unverified -> terminal_verified and stamps timestamps", () => {
    const r = repo();
    r.reserveDispatch(dispatch());
    const accepted = r.transition("dsp_1", "accepted", { callId: "call_1" });
    expect(accepted.submittedAt).not.toBeNull();
    r.transition("dsp_1", "terminal_unverified");
    const done = r.transition("dsp_1", "terminal_verified");
    expect(done.terminalAt).not.toBeNull();
    expect(r.listAudit().map((a) => a.to)).toEqual(["terminal_verified", "terminal_unverified", "accepted", "reserved"]);
  });
  it("refuses illegal transitions", () => {
    const r = repo();
    r.reserveDispatch(dispatch());
    expect(() => r.transition("dsp_1", "terminal_verified")).toThrow(/illegal/);
    r.transition("dsp_1", "submission_unknown", { note: "timeout" });
    expect(() => r.transition("dsp_1", "terminal_unverified")).toThrow(/illegal/);
    expect(r.transition("dsp_1", "accepted", { callId: "call_2" }).callId).toBe("call_2");
  });
});

describe("webhook inbox", () => {
  it("inserts once, ignores identical redelivery, quarantines a conflicting body", () => {
    const r = repo();
    expect(r.receiveEvent("evt_1", "call_1", "call.completed", '{"id":"evt_1"}')).toBe("inserted");
    expect(r.receiveEvent("evt_1", "call_1", "call.completed", '{"id":"evt_1"}')).toBe("duplicate");
    expect(r.receiveEvent("evt_1", "call_1", "call.completed", '{"id":"evt_1","x":1}')).toBe("conflict");
    expect(r.pendingEvents()).toHaveLength(0);
  });
  it("lists pending events until processed", () => {
    const r = repo();
    r.receiveEvent("evt_2", "call_2", "call.failed", "{}");
    expect(r.pendingEvents().map((e) => e.eventId)).toEqual(["evt_2"]);
    r.markEventProcessed("evt_2", "verified");
    expect(r.pendingEvents()).toHaveLength(0);
  });
});

describe("observations", () => {
  it("is idempotent per dispatch and recipient", () => {
    const r = repo();
    const obs = {
      id: "obs_1",
      watchId: "w",
      findRequestId: null,
      siteId: "s1",
      dispatchId: "dsp_1",
      callId: "call_1",
      recipientId: "rcp_1",
      source: "sweep" as const,
      observedAt: "2026-09-07T00:00:00Z",
      outcome: "in_stock" as const,
      answeredBy: "human" as const,
      reachedPharmacy: "yes" as const,
      restockExpectation: "",
      quantityNote: "",
      evidenceQuote: "yes",
      taskConfidenceScore: 0.9,
      taskConfidenceLabel: "high",
      doNotCallRequest: false,
      holdResponse: "not_asked" as const,
      usable: true,
      usableReason: "verified",
      simulated: true,
      transcriptTurns: 3
    };
    expect(r.insertObservation(obs)).toBe(true);
    expect(r.insertObservation({ ...obs, id: "obs_dup" })).toBe(false);
    expect(r.listObservations({ siteId: "s1" })).toHaveLength(1);
  });
});

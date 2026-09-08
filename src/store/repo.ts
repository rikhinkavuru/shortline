import { createHash } from "node:crypto";
import type { SiteHistory } from "../domain/sampling.js";
import type { Dispatch, DispatchState, Estimate, FindRequest, Observation, Site, Sweep, Watch } from "../domain/types.js";
import { type Db, withTx } from "./db.js";

type Row = Record<string, unknown>;

function nowIso(): string {
  return new Date().toISOString();
}

function rowToSite(row: Row): Site {
  const site: Site = {
    id: String(row.id),
    name: String(row.name),
    kind: row.kind as Site["kind"],
    phone: String(row.phone),
    region: String(row.region),
    timezone: String(row.timezone),
    source: { kind: row.source_kind as Site["source"]["kind"], ref: String(row.source_ref) },
    optOut: Number(row.opt_out) === 1,
    createdAt: String(row.created_at)
  };
  if (row.lat !== null && row.lat !== undefined) {
    site.lat = Number(row.lat);
  }
  if (row.lng !== null && row.lng !== undefined) {
    site.lng = Number(row.lng);
  }
  if (row.opt_out_reason) {
    site.optOutReason = String(row.opt_out_reason);
  }
  if (row.scenario) {
    site.scenario = String(row.scenario);
  }
  return site;
}

function rowToDispatch(row: Row): Dispatch {
  return {
    id: String(row.id),
    kind: row.kind as Dispatch["kind"],
    watchId: (row.watch_id as string | null) ?? null,
    findRequestId: (row.find_request_id as string | null) ?? null,
    sweepId: (row.sweep_id as string | null) ?? null,
    waveIndex: row.wave_index === null || row.wave_index === undefined ? null : Number(row.wave_index),
    idempotencyKey: String(row.idempotency_key),
    siteIds: JSON.parse(String(row.site_ids)) as string[],
    taskText: String(row.task_text),
    schemaVersion: String(row.schema_version),
    state: row.state as DispatchState,
    callId: (row.call_id as string | null) ?? null,
    simulated: Number(row.simulated) === 1,
    createdAt: String(row.created_at),
    submittedAt: (row.submitted_at as string | null) ?? null,
    terminalAt: (row.terminal_at as string | null) ?? null,
    note: (row.note as string | null) ?? null
  };
}

function rowToObservation(row: Row): Observation {
  return {
    id: String(row.id),
    watchId: (row.watch_id as string | null) ?? null,
    findRequestId: (row.find_request_id as string | null) ?? null,
    siteId: String(row.site_id),
    dispatchId: String(row.dispatch_id),
    callId: String(row.call_id),
    recipientId: String(row.recipient_id),
    source: row.source as Observation["source"],
    observedAt: String(row.observed_at),
    outcome: row.outcome as Observation["outcome"],
    answeredBy: row.answered_by as Observation["answeredBy"],
    reachedPharmacy: row.reached_pharmacy as Observation["reachedPharmacy"],
    restockExpectation: String(row.restock_expectation),
    quantityNote: String(row.quantity_note),
    evidenceQuote: String(row.evidence_quote),
    taskConfidenceScore: row.task_conf_score === null || row.task_conf_score === undefined ? null : Number(row.task_conf_score),
    taskConfidenceLabel: (row.task_conf_label as string | null) ?? null,
    doNotCallRequest: Number(row.do_not_call) === 1,
    holdResponse: row.hold_response as Observation["holdResponse"],
    usable: Number(row.usable) === 1,
    usableReason: String(row.usable_reason),
    simulated: Number(row.simulated) === 1,
    transcriptTurns: Number(row.transcript_turns)
  };
}

const ALLOWED: Record<DispatchState, DispatchState[]> = {
  reserved: ["accepted", "submission_unknown", "needs_human"],
  submission_unknown: ["accepted", "needs_human"],
  accepted: ["terminal_unverified", "needs_human"],
  terminal_unverified: ["terminal_verified", "needs_human"],
  terminal_verified: [],
  needs_human: ["accepted", "terminal_unverified", "terminal_verified"]
};

export class Repo {
  constructor(readonly db: Db) {}

  // ---- sites -------------------------------------------------------------

  upsertSite(site: Site): void {
    this.db
      .prepare(
        `INSERT INTO sites (id, name, kind, phone, region, timezone, lat, lng, source_kind, source_ref, opt_out, opt_out_reason, scenario, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, phone = excluded.phone, region = excluded.region,
           timezone = excluded.timezone, lat = excluded.lat, lng = excluded.lng, source_kind = excluded.source_kind,
           source_ref = excluded.source_ref, scenario = excluded.scenario`
      )
      .run(
        site.id,
        site.name,
        site.kind,
        site.phone,
        site.region,
        site.timezone,
        site.lat ?? null,
        site.lng ?? null,
        site.source.kind,
        site.source.ref,
        site.optOut ? 1 : 0,
        site.optOutReason ?? null,
        site.scenario ?? null,
        site.createdAt
      );
  }

  listSites(): Site[] {
    return (this.db.prepare("SELECT * FROM sites ORDER BY region, kind, name").all() as Row[]).map(rowToSite);
  }

  getSite(id: string): Site | null {
    const row = this.db.prepare("SELECT * FROM sites WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToSite(row) : null;
  }

  getSiteByPhone(phone: string): Site | null {
    const row = this.db.prepare("SELECT * FROM sites WHERE phone = ?").get(phone) as Row | undefined;
    return row ? rowToSite(row) : null;
  }

  setOptOut(siteId: string, optOut: boolean, reason: string | null): void {
    this.db.prepare("UPDATE sites SET opt_out = ?, opt_out_reason = ? WHERE id = ?").run(optOut ? 1 : 0, reason, siteId);
    this.audit("site", siteId, null, optOut ? "opted_out" : "opt_in", reason);
  }

  // ---- watches -----------------------------------------------------------

  upsertWatch(watch: Watch): void {
    this.db.prepare("INSERT INTO watches (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json").run(watch.id, JSON.stringify(watch));
  }

  listWatches(): Watch[] {
    return (this.db.prepare("SELECT json FROM watches ORDER BY id").all() as Row[]).map((r) => JSON.parse(String(r.json)) as Watch);
  }

  getWatch(id: string): Watch | null {
    const row = this.db.prepare("SELECT json FROM watches WHERE id = ?").get(id) as Row | undefined;
    return row ? (JSON.parse(String(row.json)) as Watch) : null;
  }

  // ---- site/watch history --------------------------------------------------

  siteHistory(siteId: string, watchId: string): SiteHistory {
    const sw = this.db.prepare("SELECT * FROM site_watch WHERE site_id = ? AND watch_id = ?").get(siteId, watchId) as Row | undefined;
    const lastForWatch = this.db
      .prepare("SELECT MAX(observed_at) AS at FROM observations WHERE site_id = ? AND watch_id = ?")
      .get(siteId, watchId) as Row | undefined;
    const lastAny = this.db.prepare("SELECT MAX(observed_at) AS at FROM observations WHERE site_id = ?").get(siteId) as Row | undefined;
    const wrongAny = this.db.prepare("SELECT COUNT(*) AS n FROM site_watch WHERE site_id = ? AND wrong_number = 1").get(siteId) as Row | undefined;
    return {
      lastAskedForWatch: lastForWatch?.at ? new Date(String(lastForWatch.at)) : null,
      lastCalledAny: lastAny?.at ? new Date(String(lastAny.at)) : null,
      carries: sw ? Number(sw.carries) === 1 : true,
      refusedAt: sw?.refused_at ? new Date(String(sw.refused_at)) : null,
      wrongNumber: Number(wrongAny?.n ?? 0) > 0
    };
  }

  private ensureSiteWatch(siteId: string, watchId: string): void {
    this.db.prepare("INSERT OR IGNORE INTO site_watch (site_id, watch_id) VALUES (?, ?)").run(siteId, watchId);
  }

  markCarries(siteId: string, watchId: string, carries: boolean): void {
    this.ensureSiteWatch(siteId, watchId);
    this.db.prepare("UPDATE site_watch SET carries = ? WHERE site_id = ? AND watch_id = ?").run(carries ? 1 : 0, siteId, watchId);
  }

  markRefused(siteId: string, watchId: string, at: string): void {
    this.ensureSiteWatch(siteId, watchId);
    this.db.prepare("UPDATE site_watch SET refused_at = ? WHERE site_id = ? AND watch_id = ?").run(at, siteId, watchId);
  }

  markWrongNumber(siteId: string, watchId: string): void {
    this.ensureSiteWatch(siteId, watchId);
    this.db.prepare("UPDATE site_watch SET wrong_number = 1 WHERE site_id = ? AND watch_id = ?").run(siteId, watchId);
  }

  // ---- sweeps ------------------------------------------------------------

  getSweep(watchId: string, isoWeek: string): Sweep | null {
    const row = this.db.prepare("SELECT * FROM sweeps WHERE watch_id = ? AND iso_week = ?").get(watchId, isoWeek) as Row | undefined;
    if (!row) {
      return null;
    }
    return {
      id: String(row.id),
      watchId: String(row.watch_id),
      isoWeek: String(row.iso_week),
      plannedSiteIds: JSON.parse(String(row.planned_site_ids)) as string[],
      undersampledStrata: JSON.parse(String(row.undersampled)) as string[],
      createdAt: String(row.created_at),
      status: row.status as Sweep["status"]
    };
  }

  saveSweep(sweep: Sweep): void {
    this.db
      .prepare(
        `INSERT INTO sweeps (id, watch_id, iso_week, planned_site_ids, undersampled, created_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(watch_id, iso_week) DO UPDATE SET planned_site_ids = excluded.planned_site_ids, undersampled = excluded.undersampled, status = excluded.status`
      )
      .run(sweep.id, sweep.watchId, sweep.isoWeek, JSON.stringify(sweep.plannedSiteIds), JSON.stringify(sweep.undersampledStrata), sweep.createdAt, sweep.status);
  }

  listSweeps(watchId: string): Sweep[] {
    return (this.db.prepare("SELECT * FROM sweeps WHERE watch_id = ? ORDER BY iso_week").all(watchId) as Row[]).map((row) => ({
      id: String(row.id),
      watchId: String(row.watch_id),
      isoWeek: String(row.iso_week),
      plannedSiteIds: JSON.parse(String(row.planned_site_ids)) as string[],
      undersampledStrata: JSON.parse(String(row.undersampled)) as string[],
      createdAt: String(row.created_at),
      status: row.status as Sweep["status"]
    }));
  }

  // ---- dispatches --------------------------------------------------------

  /** Persist the intent *before* anything crosses the real-call boundary. */
  reserveDispatch(dispatch: Dispatch): Dispatch {
    return withTx(this.db, () => {
      const existing = this.getDispatchByKey(dispatch.idempotencyKey);
      if (existing) {
        return existing;
      }
      this.db
        .prepare(
          `INSERT INTO dispatches (id, kind, watch_id, find_request_id, sweep_id, wave_index, idempotency_key, site_ids, task_text, schema_version, state, call_id, simulated, created_at, submitted_at, terminal_at, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', NULL, ?, ?, NULL, NULL, NULL)`
        )
        .run(
          dispatch.id,
          dispatch.kind,
          dispatch.watchId,
          dispatch.findRequestId,
          dispatch.sweepId,
          dispatch.waveIndex,
          dispatch.idempotencyKey,
          JSON.stringify(dispatch.siteIds),
          dispatch.taskText,
          dispatch.schemaVersion,
          dispatch.simulated ? 1 : 0,
          dispatch.createdAt
        );
      this.audit("dispatch", dispatch.id, null, "reserved", null);
      return { ...dispatch, state: "reserved", callId: null, submittedAt: null, terminalAt: null, note: null };
    });
  }

  getDispatch(id: string): Dispatch | null {
    const row = this.db.prepare("SELECT * FROM dispatches WHERE id = ?").get(id) as Row | undefined;
    return row ? rowToDispatch(row) : null;
  }

  getDispatchByKey(key: string): Dispatch | null {
    const row = this.db.prepare("SELECT * FROM dispatches WHERE idempotency_key = ?").get(key) as Row | undefined;
    return row ? rowToDispatch(row) : null;
  }

  getDispatchByCallId(callId: string): Dispatch | null {
    const row = this.db.prepare("SELECT * FROM dispatches WHERE call_id = ?").get(callId) as Row | undefined;
    return row ? rowToDispatch(row) : null;
  }

  listDispatches(filter: { states?: DispatchState[]; watchId?: string; findRequestId?: string; sweepId?: string } = {}): Dispatch[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.states && filter.states.length > 0) {
      clauses.push(`state IN (${filter.states.map(() => "?").join(",")})`);
      params.push(...filter.states);
    }
    if (filter.watchId) {
      clauses.push("watch_id = ?");
      params.push(filter.watchId);
    }
    if (filter.findRequestId) {
      clauses.push("find_request_id = ?");
      params.push(filter.findRequestId);
    }
    if (filter.sweepId) {
      clauses.push("sweep_id = ?");
      params.push(filter.sweepId);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT * FROM dispatches ${where} ORDER BY created_at DESC`).all(...(params as string[])) as Row[]).map(rowToDispatch);
  }

  transition(dispatchId: string, to: DispatchState, patch: { callId?: string | null; note?: string | null } = {}): Dispatch {
    return withTx(this.db, () => {
      const current = this.getDispatch(dispatchId);
      if (!current) {
        throw new Error(`dispatch ${dispatchId} not found`);
      }
      if (current.state !== to && !ALLOWED[current.state].includes(to)) {
        throw new Error(`illegal dispatch transition ${current.state} -> ${to} for ${dispatchId}`);
      }
      const at = nowIso();
      const submittedAt = to === "accepted" && !current.submittedAt ? at : current.submittedAt;
      const terminalAt = to === "terminal_verified" ? at : current.terminalAt;
      const callId = patch.callId === undefined ? current.callId : patch.callId;
      const note = patch.note === undefined ? current.note : patch.note;
      this.db
        .prepare("UPDATE dispatches SET state = ?, call_id = ?, submitted_at = ?, terminal_at = ?, note = ? WHERE id = ?")
        .run(to, callId, submittedAt, terminalAt, note, dispatchId);
      if (current.state !== to) {
        this.audit("dispatch", dispatchId, current.state, to, note ?? null);
      }
      return { ...current, state: to, callId, submittedAt, terminalAt, note };
    });
  }

  // ---- observations ------------------------------------------------------

  insertObservation(obs: Observation): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO observations (id, watch_id, find_request_id, site_id, dispatch_id, call_id, recipient_id, source, observed_at, outcome, answered_by, reached_pharmacy,
           restock_expectation, quantity_note, evidence_quote, task_conf_score, task_conf_label, do_not_call, hold_response, usable, usable_reason, simulated, transcript_turns)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        obs.id,
        obs.watchId,
        obs.findRequestId,
        obs.siteId,
        obs.dispatchId,
        obs.callId,
        obs.recipientId,
        obs.source,
        obs.observedAt,
        obs.outcome,
        obs.answeredBy,
        obs.reachedPharmacy,
        obs.restockExpectation,
        obs.quantityNote,
        obs.evidenceQuote,
        obs.taskConfidenceScore,
        obs.taskConfidenceLabel,
        obs.doNotCallRequest ? 1 : 0,
        obs.holdResponse,
        obs.usable ? 1 : 0,
        obs.usableReason,
        obs.simulated ? 1 : 0,
        obs.transcriptTurns
      );
    return Number(result.changes) > 0;
  }

  listObservations(filter: { watchId?: string; findRequestId?: string; siteId?: string; dispatchId?: string; since?: string; limit?: number } = {}): Observation[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (filter.watchId) {
      clauses.push("watch_id = ?");
      params.push(filter.watchId);
    }
    if (filter.findRequestId) {
      clauses.push("find_request_id = ?");
      params.push(filter.findRequestId);
    }
    if (filter.siteId) {
      clauses.push("site_id = ?");
      params.push(filter.siteId);
    }
    if (filter.dispatchId) {
      clauses.push("dispatch_id = ?");
      params.push(filter.dispatchId);
    }
    if (filter.since) {
      clauses.push("observed_at >= ?");
      params.push(filter.since);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit ? `LIMIT ${Math.max(1, Math.floor(filter.limit))}` : "";
    return (this.db.prepare(`SELECT * FROM observations ${where} ORDER BY observed_at DESC ${limit}`).all(...(params as string[])) as Row[]).map(rowToObservation);
  }

  latestUsableForSite(siteId: string, watchId: string | null, productKey: string | null): Observation | null {
    const rows = this.db
      .prepare("SELECT * FROM observations WHERE site_id = ? AND usable = 1 ORDER BY observed_at DESC LIMIT 20")
      .all(siteId) as Row[];
    for (const row of rows) {
      const obs = rowToObservation(row);
      if (watchId && obs.watchId === watchId) {
        return obs;
      }
      if (!watchId && productKey) {
        return obs;
      }
    }
    return null;
  }

  saveTranscript(dispatchId: string, recipientId: string, siteId: string, turns: unknown[]): void {
    this.db
      .prepare("INSERT OR REPLACE INTO transcripts (dispatch_id, recipient_id, site_id, json, stored_at) VALUES (?, ?, ?, ?, ?)")
      .run(dispatchId, recipientId, siteId, JSON.stringify(turns), nowIso());
  }

  getTranscript(dispatchId: string, recipientId: string): unknown[] | null {
    const row = this.db.prepare("SELECT json FROM transcripts WHERE dispatch_id = ? AND recipient_id = ?").get(dispatchId, recipientId) as Row | undefined;
    return row ? (JSON.parse(String(row.json)) as unknown[]) : null;
  }

  purgeTranscriptsOlderThan(days: number): number {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const result = this.db.prepare("DELETE FROM transcripts WHERE stored_at < ?").run(cutoff);
    return Number(result.changes);
  }

  // ---- estimates ---------------------------------------------------------

  saveEstimate(estimate: Estimate): void {
    this.db
      .prepare("INSERT INTO estimates (watch_id, iso_week, json) VALUES (?, ?, ?) ON CONFLICT(watch_id, iso_week) DO UPDATE SET json = excluded.json")
      .run(estimate.watchId, estimate.isoWeek, JSON.stringify(estimate));
  }

  listEstimates(watchId: string): Estimate[] {
    return (this.db.prepare("SELECT json FROM estimates WHERE watch_id = ? ORDER BY iso_week").all(watchId) as Row[]).map((r) => JSON.parse(String(r.json)) as Estimate);
  }

  // ---- webhook inbox -----------------------------------------------------

  /**
   * Insert one inbox row per event id. Returns `inserted`, `duplicate`
   * (same digest, safe to ignore), or `conflict` (same id, different body:
   * quarantined, never overwritten).
   */
  receiveEvent(eventId: string, callId: string, type: string, rawBody: string): "inserted" | "duplicate" | "conflict" {
    const digest = createHash("sha256").update(rawBody).digest("hex");
    return withTx(this.db, () => {
      const existing = this.db.prepare("SELECT payload_digest FROM inbox WHERE event_id = ?").get(eventId) as Row | undefined;
      if (existing) {
        if (String(existing.payload_digest) === digest) {
          return "duplicate";
        }
        this.db.prepare("UPDATE inbox SET quarantined = 1, note = 'conflicting redelivery' WHERE event_id = ?").run(eventId);
        return "conflict";
      }
      this.db.prepare("INSERT INTO inbox (event_id, call_id, type, received_at, payload_digest) VALUES (?, ?, ?, ?, ?)").run(eventId, callId, type, nowIso(), digest);
      return "inserted";
    });
  }

  markEventProcessed(eventId: string, note: string | null = null): void {
    this.db.prepare("UPDATE inbox SET processed_at = ?, note = COALESCE(?, note) WHERE event_id = ?").run(nowIso(), note, eventId);
  }

  pendingEvents(): Array<{ eventId: string; callId: string; type: string }> {
    return (this.db.prepare("SELECT event_id, call_id, type FROM inbox WHERE processed_at IS NULL AND quarantined = 0 ORDER BY received_at").all() as Row[]).map((r) => ({
      eventId: String(r.event_id),
      callId: String(r.call_id),
      type: String(r.type)
    }));
  }

  // ---- find requests -----------------------------------------------------

  saveFind(request: FindRequest): void {
    this.db
      .prepare("INSERT INTO find_requests (id, json, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json")
      .run(request.id, JSON.stringify(request), request.createdAt);
  }

  getFind(id: string): FindRequest | null {
    const row = this.db.prepare("SELECT json FROM find_requests WHERE id = ?").get(id) as Row | undefined;
    return row ? (JSON.parse(String(row.json)) as FindRequest) : null;
  }

  listFinds(limit = 20): FindRequest[] {
    return (this.db.prepare("SELECT json FROM find_requests ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]).map((r) => JSON.parse(String(r.json)) as FindRequest);
  }

  // ---- audit -------------------------------------------------------------

  audit(entity: string, entityId: string, from: string | null, to: string, note: string | null): void {
    this.db.prepare("INSERT INTO audit (at, entity, entity_id, from_state, to_state, note) VALUES (?, ?, ?, ?, ?, ?)").run(nowIso(), entity, entityId, from, to, note);
  }

  listAudit(limit = 100): Array<{ at: string; entity: string; entityId: string; from: string | null; to: string; note: string | null }> {
    return (this.db.prepare("SELECT * FROM audit ORDER BY id DESC LIMIT ?").all(limit) as Row[]).map((r) => ({
      at: String(r.at),
      entity: String(r.entity),
      entityId: String(r.entity_id),
      from: (r.from_state as string | null) ?? null,
      to: String(r.to_state),
      note: (r.note as string | null) ?? null
    }));
  }
}

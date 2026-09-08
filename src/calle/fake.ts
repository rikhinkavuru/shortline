import { createHash, randomBytes } from "node:crypto";
import { type CallProvider, type CreateBatchInput, type ProviderCall, type ProviderEvent, type ProviderRecipient, ProviderError, isTerminal } from "./provider.js";
import { DEFAULT_MIX, SCENARIOS, pickScenario } from "./scenarios.js";
import { hashString, mulberry32 } from "../domain/random.js";

export interface FakeSpeed {
  queueMs: number;
  ringMs: number;
  talkMs: number;
}

export interface FakeWebhookEvent {
  id: string;
  type: "call.completed" | "call.failed";
  createdAt: string;
  call: ProviderCall;
}

export interface FakeProviderOptions {
  /** Stage durations. `instant` completes synchronously inside `create`. */
  speed?: FakeSpeed | "instant";
  /** Scenario name for a phone, or undefined to use the seeded default mix. */
  resolver?: (phone: string) => string | undefined;
  /** Called once per terminal call when the create request carried a webhook URL. */
  onWebhook?: (url: string, event: FakeWebhookEvent) => Promise<void> | void;
  clock?: () => Date;
}

interface InternalCall {
  call: ProviderCall;
  webhookUrl: string | undefined;
  timers: NodeJS.Timeout[];
}

function digest(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * In-process CALL-E stand-in. Honours idempotency keys exactly like the
 * real API (same key + same body → same call; same key + different body →
 * `idempotency_conflict`), walks each recipient through queued →
 * in_progress → terminal, emits developer events, and delivers a terminal
 * webhook when asked. It never touches a network.
 */
export class FakeCalleProvider implements CallProvider {
  readonly mode = "fake" as const;
  private readonly calls = new Map<string, InternalCall>();
  private readonly byKey = new Map<string, { digest: string; callId: string }>();
  private readonly events = new Map<string, ProviderEvent[]>();
  private readonly options: FakeProviderOptions;
  /** Weighted scenario mix for sites without an explicit scenario. Mutable so a demo can simulate a worsening shortage. */
  mix: Array<[string, number]> = DEFAULT_MIX;

  constructor(options: FakeProviderOptions = {}) {
    this.options = options;
  }

  private now(): Date {
    return this.options.clock ? this.options.clock() : new Date();
  }

  private emit(callId: string, type: string, message: string, status: string, details: Record<string, unknown> = {}): void {
    const list = this.events.get(callId) ?? [];
    list.push({
      id: `evt_${randomBytes(6).toString("hex")}`,
      type,
      callId,
      createdAt: this.now().toISOString(),
      level: "info",
      status,
      message,
      details
    });
    this.events.set(callId, list);
  }

  private scenarioFor(phone: string, callId: string): string {
    const explicit = this.options.resolver?.(phone);
    if (explicit && SCENARIOS[explicit]) {
      return explicit;
    }
    const rng = mulberry32(hashString(`${phone}:${callId}`));
    return pickScenario(rng(), this.mix);
  }

  async create(input: CreateBatchInput, idempotencyKey: string): Promise<ProviderCall> {
    if (!idempotencyKey) {
      throw new ProviderError({ code: "invalid_request", message: "Idempotency-Key is required.", status: 400, retrySafe: false, callStarted: false });
    }
    const bodyDigest = digest(input);
    const existing = this.byKey.get(idempotencyKey);
    if (existing) {
      if (existing.digest !== bodyDigest) {
        throw new ProviderError({
          code: "idempotency_conflict",
          message: "Idempotency-Key was reused with a different request body.",
          status: 409,
          retrySafe: false,
          callStarted: false
        });
      }
      return this.get(existing.callId);
    }
    for (const r of input.recipients) {
      if (!/^\+[1-9]\d{6,14}$/.test(r.phone)) {
        throw new ProviderError({ code: "invalid_phone", message: `Recipient phone is not E.164.`, status: 422, retrySafe: false, callStarted: false });
      }
    }
    if (input.recipients.length === 0) {
      throw new ProviderError({ code: "no_recipients", message: "No recipients.", status: 422, retrySafe: false, callStarted: false });
    }
    const callId = `call_fake_${randomBytes(6).toString("hex")}`;
    const createdAt = this.now().toISOString();
    const recipients: ProviderRecipient[] = input.recipients.map((r) => ({
      id: `rcp_${randomBytes(4).toString("hex")}`,
      phones: [r.phone],
      status: "queued",
      structuredResult: null,
      summary: null,
      attempts: []
    }));
    const call: ProviderCall = {
      id: callId,
      status: "queued",
      task: input.task,
      recipients,
      structuredResult: null,
      summary: null,
      taskCompleted: null,
      completionConfidence: null,
      evidence: [],
      metadata: clone(input.metadata),
      failureCode: null,
      failureMessage: null,
      createdAt,
      completedAt: null
    };
    this.calls.set(callId, { call, webhookUrl: input.webhookUrl, timers: [] });
    this.byKey.set(idempotencyKey, { digest: bodyDigest, callId });
    this.emit(callId, "call.created", "Call task accepted.", "queued", { recipients: recipients.length });
    this.schedule(callId);
    return this.get(callId);
  }

  private schedule(callId: string): void {
    const entry = this.calls.get(callId);
    if (!entry) {
      return;
    }
    const speed = this.options.speed ?? "instant";
    if (speed === "instant") {
      for (const r of entry.call.recipients) {
        this.startRecipient(callId, r.id);
        this.finishRecipient(callId, r.id);
      }
      this.finishCall(callId);
      return;
    }
    entry.call.recipients.forEach((r, index) => {
      const jitter = index * 400;
      const t1 = setTimeout(() => this.startRecipient(callId, r.id), speed.queueMs + jitter);
      const t2 = setTimeout(() => {
        this.finishRecipient(callId, r.id);
        if (entry.call.recipients.every((x) => isTerminal(x.status))) {
          this.finishCall(callId);
        }
      }, speed.queueMs + speed.ringMs + speed.talkMs + jitter);
      t1.unref();
      t2.unref();
      entry.timers.push(t1, t2);
    });
  }

  private startRecipient(callId: string, recipientId: string): void {
    const entry = this.calls.get(callId);
    const recipient = entry?.call.recipients.find((r) => r.id === recipientId);
    if (!entry || !recipient || recipient.status !== "queued") {
      return;
    }
    recipient.status = "in_progress";
    entry.call.status = "in_progress";
    recipient.attempts.push({
      id: `att_${randomBytes(4).toString("hex")}`,
      phone: recipient.phones[0] ?? "",
      status: "in_progress",
      startedAt: this.now().toISOString(),
      completedAt: null,
      transcriptTurns: [],
      failureCode: null,
      failureMessage: null
    });
    this.emit(callId, "call.dialing", "Dialing recipient.", "in_progress", { recipient_id: recipientId });
  }

  private finishRecipient(callId: string, recipientId: string): void {
    const entry = this.calls.get(callId);
    const recipient = entry?.call.recipients.find((r) => r.id === recipientId);
    if (!entry || !recipient || isTerminal(recipient.status)) {
      return;
    }
    const attempt = recipient.attempts[recipient.attempts.length - 1];
    if (!attempt) {
      return;
    }
    const scenarioName = this.scenarioFor(recipient.phones[0] ?? "", callId);
    const scenario = SCENARIOS[scenarioName] ?? SCENARIOS.in_stock_human!;
    const productLabel = typeof entry.call.metadata.product_label === "string" ? entry.call.metadata.product_label : "the product";
    attempt.completedAt = this.now().toISOString();
    attempt.transcriptTurns = scenario.turns(productLabel);
    attempt.status = scenario.recipientStatus;
    if (scenario.recipientStatus === "failed") {
      attempt.failureCode = scenario.failureCode ?? "failed";
      attempt.failureMessage = scenario.summary;
      recipient.status = "failed";
      recipient.summary = scenario.summary;
      recipient.structuredResult = null;
      this.emit(callId, "call.recipient_failed", scenario.summary, "in_progress", { recipient_id: recipientId, scenario: scenarioName });
      return;
    }
    recipient.status = "completed";
    recipient.summary = scenario.summary;
    recipient.structuredResult = scenario.structuredResult ? clone(scenario.structuredResult) : null;
    this.emit(callId, "call.recipient_completed", scenario.summary, "in_progress", { recipient_id: recipientId, scenario: scenarioName });
  }

  private finishCall(callId: string): void {
    const entry = this.calls.get(callId);
    if (!entry || isTerminal(entry.call.status)) {
      return;
    }
    const call = entry.call;
    const completed = call.recipients.filter((r) => r.status === "completed");
    const reached = completed.filter((r) => r.structuredResult?.reached_pharmacy === "yes").length;
    call.status = completed.length > 0 ? "completed" : "failed";
    call.completedAt = this.now().toISOString();
    call.summary = `${reached} of ${call.recipients.length} recipients reached pharmacy staff.`;
    call.taskCompleted = reached > 0;
    const score = call.recipients.length === 0 ? 0 : Math.round((reached / call.recipients.length) * 100) / 100;
    call.completionConfidence = { score: Math.max(0.35, score), label: score >= 0.7 ? "high" : score >= 0.4 ? "medium" : "low" };
    call.evidence = completed.map((r) => r.summary ?? "").filter(Boolean);
    call.structuredResult = { pharmacies_reached: reached };
    if (call.status === "failed") {
      call.failureCode = "all_recipients_failed";
      call.failureMessage = "No recipient completed.";
    }
    this.emit(callId, call.status === "completed" ? "call.completed" : "call.failed", call.summary, call.status);
    if (entry.webhookUrl && this.options.onWebhook) {
      const event: FakeWebhookEvent = {
        id: `evt_${randomBytes(6).toString("hex")}`,
        type: call.status === "completed" ? "call.completed" : "call.failed",
        createdAt: this.now().toISOString(),
        call: clone(call)
      };
      void Promise.resolve(this.options.onWebhook(entry.webhookUrl, event)).catch(() => undefined);
    }
  }

  async get(callId: string): Promise<ProviderCall> {
    const entry = this.calls.get(callId);
    if (!entry) {
      throw new ProviderError({ code: "not_found", message: `Call ${callId} not found.`, status: 404, retrySafe: false, callStarted: false });
    }
    return clone(entry.call);
  }

  async listEvents(callId: string): Promise<ProviderEvent[]> {
    if (!this.calls.has(callId)) {
      throw new ProviderError({ code: "not_found", message: `Call ${callId} not found.`, status: 404, retrySafe: false, callStarted: false });
    }
    return clone(this.events.get(callId) ?? []);
  }

  /** Test helper: complete every in-flight call immediately. */
  settleAll(): void {
    for (const [callId, entry] of this.calls) {
      for (const t of entry.timers) {
        clearTimeout(t);
      }
      entry.timers = [];
      for (const r of entry.call.recipients) {
        this.startRecipient(callId, r.id);
        this.finishRecipient(callId, r.id);
      }
      this.finishCall(callId);
    }
  }

  get size(): number {
    return this.calls.size;
  }
}

/**
 * Transport-neutral view of a CALL-E call task. The live adapter maps the
 * official SDK onto this shape; the fake provider produces it directly so
 * every layer above can run without credentials or a network.
 */

export interface ProviderRecipientInput {
  phone: string;
  region?: string;
  locale?: string;
}

export interface CreateBatchInput {
  task: string;
  recipients: ProviderRecipientInput[];
  recipientResultSchema: Record<string, unknown>;
  resultSchema?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  webhookUrl?: string;
}

export interface ProviderTranscriptTurn {
  offsetSeconds: number;
  speaker: "bot" | "user" | "unknown";
  text: string;
}

export interface ProviderAttempt {
  id: string;
  phone: string;
  status: string;
  startedAt: string | null;
  completedAt: string | null;
  transcriptTurns: ProviderTranscriptTurn[];
  failureCode: string | null;
  failureMessage: string | null;
}

export interface ProviderRecipient {
  id: string;
  phones: string[];
  status: string;
  structuredResult: Record<string, unknown> | null;
  summary: string | null;
  attempts: ProviderAttempt[];
}

export type ProviderCallStatus = "queued" | "in_progress" | "completed" | "failed" | "canceled" | string;

export interface ProviderCall {
  id: string;
  status: ProviderCallStatus;
  task: string;
  recipients: ProviderRecipient[];
  structuredResult: Record<string, unknown> | null;
  summary: string | null;
  taskCompleted: boolean | null;
  completionConfidence: { score: number; label: string } | null;
  evidence: string[];
  metadata: Record<string, unknown>;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ProviderEvent {
  id: string;
  type: string;
  callId: string;
  createdAt: string;
  level: string;
  status: string;
  message: string;
  details: Record<string, unknown>;
}

export class ProviderError extends Error {
  readonly code: string;
  readonly status: number | null;
  /** Whether the same request may be retried with the same idempotency key. */
  readonly retrySafe: boolean;
  /** `true`, `false`, or `"unknown"` when acceptance could not be determined. */
  readonly callStarted: boolean | "unknown";

  constructor(input: { code: string; message: string; status?: number | null; retrySafe: boolean; callStarted: boolean | "unknown" }) {
    super(input.message);
    this.name = "ProviderError";
    this.code = input.code;
    this.status = input.status ?? null;
    this.retrySafe = input.retrySafe;
    this.callStarted = input.callStarted;
  }
}

export interface EventPage {
  events: ProviderEvent[];
  /** Opaque cursor to pass back as `after` to read only newer events. */
  nextCursor: string | null;
}

export interface CallProvider {
  readonly mode: "fake" | "live";
  create(input: CreateBatchInput, idempotencyKey: string): Promise<ProviderCall>;
  get(callId: string): Promise<ProviderCall>;
  /** All developer events for a call, or only those after `after` when a cursor is given. */
  listEvents(callId: string, after?: string): Promise<ProviderEvent[]>;
  /** One page of events after the cursor, with the cursor to resume from. */
  listEventsAfter(callId: string, after: string | null): Promise<EventPage>;
}

export function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "canceled";
}

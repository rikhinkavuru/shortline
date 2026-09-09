import { CalleAPIError, CalleClient, CalleConnectionError, CalleRateLimitError, CalleTimeoutError, type Call } from "@call-e/calle";
import { type CallProvider, type CreateBatchInput, type EventPage, type ProviderCall, type ProviderEvent, ProviderError } from "./provider.js";

export interface LiveProviderOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: (input: Request) => Promise<Response>;
}

function mapCall(call: Call): ProviderCall {
  return {
    id: call.id,
    status: call.status,
    task: call.task,
    recipients: call.recipients.map((r) => ({
      id: r.id,
      phones: r.phones,
      status: r.status,
      structuredResult: r.structuredResult,
      summary: r.summary,
      attempts: r.attempts.map((a) => ({
        id: a.id,
        phone: a.phone,
        status: a.status,
        startedAt: a.startedAt,
        completedAt: a.completedAt,
        transcriptTurns: a.transcriptTurns.map((t) => ({
          offsetSeconds: t.offset_seconds ?? 0,
          speaker: t.speaker,
          text: t.text
        })),
        failureCode: a.failureCode,
        failureMessage: a.failureMessage
      }))
    })),
    structuredResult: call.structuredResult,
    summary: call.summary,
    taskCompleted: call.taskCompleted,
    completionConfidence: call.completionConfidence,
    evidence: call.evidence,
    metadata: call.metadata,
    failureCode: call.failureCode,
    failureMessage: call.failureMessage,
    createdAt: call.createdAt,
    completedAt: call.completedAt
  };
}

/**
 * Translate SDK failures into a ProviderError that says what the caller may
 * do next. Transport ambiguity on create is reported as `callStarted:
 * "unknown"` so the dispatcher records `submission_unknown` and never
 * dials again on its own.
 */
function translate(error: unknown, phase: "create" | "read"): ProviderError {
  if (error instanceof CalleRateLimitError) {
    return new ProviderError({ code: error.code, message: error.message, status: error.status, retrySafe: true, callStarted: false });
  }
  if (error instanceof CalleAPIError) {
    const retrySafe = error.code === "provider_unavailable" || error.code === "internal_error";
    return new ProviderError({ code: error.code, message: error.message, status: error.status, retrySafe, callStarted: false });
  }
  if (error instanceof CalleTimeoutError || error instanceof CalleConnectionError) {
    return new ProviderError({
      code: "transport_ambiguous",
      message: error.message,
      retrySafe: phase === "read",
      callStarted: phase === "create" ? "unknown" : false
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError({
    code: "transport_ambiguous",
    message,
    retrySafe: phase === "read",
    callStarted: phase === "create" ? "unknown" : false
  });
}

/** Adapter over the official `@call-e/calle` server SDK. */
export class LiveCalleProvider implements CallProvider {
  readonly mode = "live" as const;
  private readonly client: CalleClient;

  constructor(options: LiveProviderOptions) {
    const clientOptions: { apiKey: string; baseUrl?: string; fetch?: (input: Request) => Promise<Response> } = { apiKey: options.apiKey };
    if (options.baseUrl) {
      clientOptions.baseUrl = options.baseUrl;
    }
    if (options.fetch) {
      clientOptions.fetch = options.fetch;
    }
    this.client = new CalleClient(clientOptions);
  }

  async create(input: CreateBatchInput, idempotencyKey: string): Promise<ProviderCall> {
    try {
      const created = await this.client.calls.create(
        {
          task: input.task,
          recipients: input.recipients.map((r) => {
            const rec: { phones: string[]; region?: string; locale?: string } = { phones: [r.phone] };
            if (r.region) {
              rec.region = r.region;
            }
            if (r.locale) {
              rec.locale = r.locale;
            }
            return rec;
          }),
          recipientResultSchema: input.recipientResultSchema,
          ...(input.resultSchema ? { resultSchema: input.resultSchema } : {}),
          metadata: input.metadata,
          ...(input.webhookUrl ? { webhookUrl: input.webhookUrl } : {})
        },
        { idempotencyKey }
      );
      return mapCall(created);
    } catch (error) {
      throw translate(error, "create");
    }
  }

  async get(callId: string): Promise<ProviderCall> {
    try {
      return mapCall(await this.client.calls.get(callId));
    } catch (error) {
      throw translate(error, "read");
    }
  }

  async listEventsAfter(callId: string, after: string | null): Promise<EventPage> {
    try {
      const list = await this.client.calls.listEvents(callId, after ? { cursor: after, limit: 100 } : { limit: 100 });
      return {
        events: list.data.map((e) => ({ id: e.id, type: e.type, callId: e.call_id, createdAt: e.created_at, level: e.level, status: e.status, message: e.message, details: e.details })),
        nextCursor: list.nextCursor
      };
    } catch (error) {
      throw translate(error, "read");
    }
  }

  async listEvents(callId: string, after?: string): Promise<ProviderEvent[]> {
    try {
      const out: ProviderEvent[] = [];
      let cursor: string | undefined = after;
      for (let page = 0; page < 10; page += 1) {
        const list = await this.client.calls.listEvents(callId, cursor ? { cursor, limit: 100 } : { limit: 100 });
        for (const e of list.data) {
          out.push({
            id: e.id,
            type: e.type,
            callId: e.call_id,
            createdAt: e.created_at,
            level: e.level,
            status: e.status,
            message: e.message,
            details: e.details
          });
        }
        if (!list.nextCursor) {
          break;
        }
        cursor = list.nextCursor;
      }
      return out;
    } catch (error) {
      throw translate(error, "read");
    }
  }
}

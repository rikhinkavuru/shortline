import type { ProviderCall } from "./provider.js";

/** Serialise a ProviderCall in the exact snake_case shape of the CALL-E Calls API. */
export function toApiCallTask(call: ProviderCall): Record<string, unknown> {
  return {
    id: call.id,
    object: "call_task",
    status: call.status,
    task: call.task,
    recipients: call.recipients.map((r) => ({
      id: r.id,
      phones: r.phones,
      region: null,
      locale: null,
      status: r.status,
      structured_result: r.structuredResult,
      summary: r.summary,
      attempts: r.attempts.map((a) => ({
        id: a.id,
        phone: a.phone,
        status: a.status,
        started_at: a.startedAt,
        completed_at: a.completedAt,
        summary: null,
        transcript_turns: a.transcriptTurns.map((t) => ({ offset_seconds: t.offsetSeconds, speaker: t.speaker, text: t.text })),
        provider_call_id: null,
        failure_code: a.failureCode,
        failure_message: a.failureMessage
      }))
    })),
    structured_result: call.structuredResult,
    summary: call.summary,
    task_completed: call.taskCompleted,
    completion_confidence: call.completionConfidence,
    evidence: call.evidence,
    metadata: call.metadata,
    failure_code: call.failureCode,
    failure_message: call.failureMessage,
    created_at: call.createdAt,
    completed_at: call.completedAt
  };
}

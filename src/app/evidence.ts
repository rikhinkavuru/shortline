import { toApiCallTask } from "../calle/api-shape.js";
import type { ProviderCall, ProviderEvent } from "../calle/provider.js";
import { isFictionReserved, maskDeep } from "../domain/phone.js";
import type { Observation } from "../domain/types.js";
import type { AppContext } from "./context.js";

export interface EvidenceBundle {
  exportedAt: string;
  mode: "fake" | "live";
  call: ReturnType<typeof toApiCallTask> & { id: string; recipients: unknown[] };
  events: ProviderEvent[];
  observations: Observation[];
  readme: string;
}

/**
 * Export what a call actually returned so a reader can check the pipeline
 * against CALL-E's real output. Real numbers are replaced with numbers from
 * the NANP fiction block (still valid E.164, so the file can drive a test),
 * and free text is masked with the same routine the dashboard uses.
 */
export async function exportEvidence(ctx: AppContext, dispatchId: string): Promise<EvidenceBundle> {
  const dispatch = ctx.repo.getDispatch(dispatchId);
  if (!dispatch) {
    throw new Error(`dispatch ${dispatchId} not found`);
  }
  if (!dispatch.callId) {
    throw new Error(`dispatch ${dispatchId} has no call id yet`);
  }
  const call: ProviderCall = await ctx.provider.get(dispatch.callId);
  const events = await ctx.provider.listEvents(dispatch.callId);
  const observations = ctx.repo.listObservations({ dispatchId });
  const substitutes = new Map<string, string>();
  const substitute = (phone: string): string => {
    let s = substitutes.get(phone);
    if (!s) {
      s = `+1415555019${substitutes.size % 10}`;
      substitutes.set(phone, s);
    }
    return s;
  };
  const shaped = toApiCallTask({
    ...call,
    recipients: call.recipients.map((r) => ({
      ...r,
      phones: r.phones.map(substitute),
      attempts: r.attempts.map((a) => ({ ...a, phone: substitute(a.phone) }))
    }))
  });
  // Real numbers were replaced above with fiction-block numbers; keep those valid E.164 so the file can replay in a test.
  const masked = maskDeep(shaped, { keep: isFictionReserved }) as EvidenceBundle["call"];
  const readme = [
    `# Call evidence: ${dispatch.callId}`,
    "",
    `Exported ${new Date().toISOString()} from a ${ctx.provider.mode === "live" ? "**live CALL-E** call task" : "dry-run (fake provider) call task"}.`,
    "",
    `- Dispatch: ${dispatch.id} (${dispatch.kind}${dispatch.waveIndex !== null ? `, wave ${dispatch.waveIndex + 1}` : ""})`,
    `- Recipients: ${call.recipients.length}`,
    `- Terminal status: ${call.status}; task_completed=${String(call.taskCompleted)}; confidence=${call.completionConfidence ? `${call.completionConfidence.label} (${call.completionConfidence.score})` : "n/a"}`,
    `- Observations: ${observations.map((o) => `${o.outcome}${o.usable ? "" : ` (${o.usableReason})`}`).join(", ") || "none"}`,
    "",
    "Real phone numbers were replaced with numbers from the 555-01XX fiction block; all other text was masked with the dashboard's masking routine. Files: `call.json` is the terminal `GET /v1/calls/{id}` snapshot in API shape, `events.json` the developer events, `observations.json` the rows Shortline derived from it.",
    ""
  ].join("\n");
  return {
    exportedAt: new Date().toISOString(),
    mode: ctx.provider.mode,
    call: masked,
    events: maskDeep(events, { keep: isFictionReserved }),
    observations: maskDeep(observations, { keep: isFictionReserved }),
    readme
  };
}

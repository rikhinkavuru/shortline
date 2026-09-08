import { type CreateBatchInput, ProviderError } from "../calle/provider.js";
import { assertE164, isFictionReserved, maskPhone } from "../domain/phone.js";
import { buildRecipientResultSchema, buildTaskResultSchema, productLabel } from "../domain/task.js";
import type { Dispatch, Product, Site } from "../domain/types.js";
import type { AppContext } from "./context.js";

export interface SubmitInput {
  dispatch: Dispatch;
  sites: Site[];
  product: Product;
  askHold: boolean;
}

function countryOf(region: string): string | undefined {
  const cc = region.split("-")[0];
  return cc && /^[A-Z]{2}$/.test(cc) ? cc : undefined;
}

/**
 * No-call preflight. Everything here is checked before any credential is
 * read or any request leaves the process. It is an application-side
 * safety check, not a prediction of provider acceptance.
 */
export function preflight(ctx: AppContext, sites: Site[]): void {
  if (sites.length === 0) {
    throw new Error("preflight: no recipients");
  }
  for (const site of sites) {
    assertE164(site.phone, `site ${site.id}`);
    if (site.optOut) {
      throw new Error(`preflight: site ${site.id} has opted out`);
    }
    if (ctx.config.mode === "live" && isFictionReserved(site.phone)) {
      throw new Error(`preflight: refusing to dial fiction-reserved number ${maskPhone(site.phone)} in live mode`);
    }
  }
}

/**
 * Cross the real-call boundary exactly once per logical action.
 *
 * The dispatch row already exists in `reserved` (or `submission_unknown`
 * after an earlier ambiguous attempt). The same idempotency key and an
 * identical body are sent every time, so a replay after a crash returns the
 * original call task instead of dialling again.
 */
export async function submitDispatch(ctx: AppContext, input: SubmitInput): Promise<Dispatch> {
  const { dispatch, sites, product } = input;
  if (dispatch.state !== "reserved" && dispatch.state !== "submission_unknown") {
    return dispatch;
  }
  preflight(ctx, sites);
  const bySiteId = new Map(sites.map((s) => [s.id, s]));
  const ordered = dispatch.siteIds.map((id) => {
    const site = bySiteId.get(id);
    if (!site) {
      throw new Error(`submit: site ${id} missing from input`);
    }
    return site;
  });
  const body: CreateBatchInput = {
    task: dispatch.taskText,
    recipients: ordered.map((site) => {
      const rec: { phone: string; region?: string; locale?: string } = { phone: site.phone };
      const cc = countryOf(site.region);
      if (cc) {
        rec.region = cc;
      }
      if (cc === "US" || cc === "CA" || cc === "GB" || cc === "AU" || cc === "SG") {
        rec.locale = cc === "US" ? "en-US" : cc === "GB" ? "en-GB" : cc === "AU" ? "en-AU" : cc === "SG" ? "en-SG" : "en-CA";
      }
      return rec;
    }),
    recipientResultSchema: buildRecipientResultSchema(input.askHold),
    resultSchema: buildTaskResultSchema(),
    metadata: {
      dispatch_id: dispatch.id,
      kind: dispatch.kind,
      watch_id: dispatch.watchId ?? "",
      find_request_id: dispatch.findRequestId ?? "",
      product_label: productLabel(product),
      schema_version: dispatch.schemaVersion,
      app: "shortline"
    }
  };
  if (ctx.config.publicUrl) {
    body.webhookUrl = `${ctx.config.publicUrl}/webhooks/calle`;
  }
  try {
    const call = await ctx.provider.create(body, dispatch.idempotencyKey);
    const accepted = ctx.repo.transition(dispatch.id, "accepted", { callId: call.id, note: null });
    ctx.bus.emit({ type: "dispatch", dispatchId: accepted.id, state: accepted.state, callId: accepted.callId, kind: accepted.kind, siteIds: accepted.siteIds, note: null });
    return accepted;
  } catch (error) {
    if (error instanceof ProviderError) {
      if (error.callStarted === "unknown") {
        const unknown = ctx.repo.transition(dispatch.id, "submission_unknown", { note: `${error.code}: ${error.message}` });
        ctx.bus.emit({ type: "dispatch", dispatchId: unknown.id, state: unknown.state, callId: null, kind: unknown.kind, siteIds: unknown.siteIds, note: unknown.note });
        return unknown;
      }
      if (error.retrySafe) {
        // Leave the reservation in place; a later run replays the same key.
        ctx.bus.emit({ type: "notice", level: "warn", message: `CALL-E ${error.code} for ${dispatch.id}; will retry with the same idempotency key.` });
        throw error;
      }
      const stopped = ctx.repo.transition(dispatch.id, "needs_human", { note: `${error.code}: ${error.message}` });
      ctx.bus.emit({ type: "dispatch", dispatchId: stopped.id, state: stopped.state, callId: null, kind: stopped.kind, siteIds: stopped.siteIds, note: stopped.note });
      return stopped;
    }
    throw error;
  }
}

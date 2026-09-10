import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { AppContext } from "../app/context.js";
import { describeFind, planFind, runFind } from "../app/find.js";
import { maskDeep, maskPhone } from "../domain/phone.js";
import { productLabel } from "../domain/task.js";

function text(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(maskDeep(value), null, 2) }] };
}

/**
 * MCP surface so an agent (Claude Code, Codex, OpenClaw, ...) can read the
 * availability index and run a sourcing request. Planning never dials;
 * running requires `confirm: true` in the same request and there is no
 * setting that removes that requirement.
 */
export function buildMcpServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: "shortline", version: "0.1.0" });

  server.registerTool(
    "shortline_watch_status",
    {
      title: "Availability index for a watched product",
      description: "Read the latest weekly availability estimate (with 95% interval, coverage, response rate, and signal) for a watched product. Read-only; places no call.",
      inputSchema: { watch_id: z.string().optional().describe("Watch id. Omit to list all watches with their latest signal.") },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ watch_id }) => {
      if (!watch_id) {
        const watches = ctx.repo.listWatches().map((w) => {
          const latest = ctx.repo.listEstimates(w.id).at(-1) ?? null;
          return { watch_id: w.id, product: productLabel(w.product), status: w.status, regions: w.regions, latest };
        });
        return text({ mode: ctx.config.mode, watches });
      }
      const watch = ctx.repo.getWatch(watch_id);
      if (!watch) {
        return text({ error: "watch_not_found" });
      }
      const estimates = ctx.repo.listEstimates(watch.id);
      return text({ mode: ctx.config.mode, watch_id: watch.id, product: productLabel(watch.product), regions: watch.regions, latest: estimates.at(-1) ?? null, history: estimates.slice(-8) });
    }
  );

  server.registerTool(
    "shortline_list_sites",
    {
      title: "List pharmacies in the frame",
      description: "List sites Shortline may call, with masked numbers, last outcome, and opt-out state. Read-only.",
      inputSchema: { region: z.string().optional() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ region }) => {
      const sites = ctx.repo
        .listSites()
        .filter((s) => !region || s.region === region)
        .map((s) => {
          const last = ctx.repo.listObservations({ siteId: s.id, limit: 1 })[0] ?? null;
          return { site_id: s.id, name: s.name, kind: s.kind, region: s.region, phone: maskPhone(s.phone), opt_out: s.optOut, last_outcome: last?.outcome ?? null, last_observed_at: last?.observedAt ?? null };
        });
      return text({ sites });
    }
  );

  server.registerTool(
    "shortline_plan_find",
    {
      title: "Plan a sourcing request (no call)",
      description:
        "Plan which pharmacies would be called, in waves, to find a product in a region. Returns known sources from recent monitoring (no call needed), the ranked candidates with masked numbers, the calls the first wave would place, and the maximum the whole request could place. Does NOT place any call.",
      inputSchema: {
        watch_id: z.string().optional().describe("Use the watched product's settings."),
        product: z
          .object({
            name: z.string().min(2).max(60).regex(/^[A-Za-z0-9][A-Za-z0-9 .,'/%()+-]*$/),
            strength: z.string().max(30).regex(/^[A-Za-z0-9][A-Za-z0-9 .,'/%()+-]*$/).optional(),
            form: z.string().max(30).regex(/^[A-Za-z0-9][A-Za-z0-9 .,'/%()+-]*$/).optional()
          })
          .optional()
          .describe("Ad-hoc product when no watch exists. Plain text only; this is spoken to a stranger."),
        region: z.string().describe("Region code, e.g. US-CA-SF"),
        need: z.number().int().min(1).max(10).optional().describe("Confirmed sources wanted (default 2)"),
        wave_size: z.number().int().min(1).max(6).optional(),
        max_waves: z.number().int().min(1).max(8).optional(),
        ask_hold: z.boolean().optional().describe("Also ask staff to hold one fill for pickup today. A yes is a stated intention, not a reservation."),
        near: z.object({ lat: z.number(), lng: z.number() }).optional(),
        only_site_ids: z.array(z.string()).optional().describe("Restrict candidates to these site ids, e.g. the operator's own test line."),
        ignore_known_sources: z.boolean().optional().describe("Dial even sites seen in stock in the last 24 hours instead of reusing the sighting (re-verification).")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async (input) => {
      const preview = planFind(ctx, {
        ...(input.watch_id ? { watchId: input.watch_id } : {}),
        ...(input.product
          ? {
              product: {
                name: input.product.name,
                ...(input.product.strength ? { strength: input.product.strength } : {}),
                ...(input.product.form ? { form: input.product.form } : {})
              }
            }
          : {}),
        region: input.region,
        ...(input.need !== undefined ? { need: input.need } : {}),
        ...(input.wave_size !== undefined ? { waveSize: input.wave_size } : {}),
        ...(input.max_waves !== undefined ? { maxWaves: input.max_waves } : {}),
        askHold: Boolean(input.ask_hold),
        ...(input.near ? { near: input.near } : {}),
        ...(input.only_site_ids && input.only_site_ids.length > 0 ? { onlySiteIds: input.only_site_ids } : {}),
        ...(input.ignore_known_sources ? { ignoreKnownSources: true } : {})
      });
      return text({
        find_request_id: preview.request.id,
        mode: ctx.config.mode,
        product: productLabel(preview.request.product),
        need: preview.request.need,
        known_sources_no_call_needed: preview.knownSources,
        candidates: preview.candidates,
        skipped: preview.skipped,
        first_wave_calls: preview.firstWaveCalls,
        max_calls: preview.maxCalls,
        next_step: `Show this plan to the user: the first wave places ${preview.firstWaveCalls} call(s) and the request may place up to ${preview.maxCalls}. Only call shortline_run_find with confirm=true after the user explicitly approves.`
      });
    }
  );

  server.registerTool(
    "shortline_run_find",
    {
      title: "Run a planned sourcing request (places calls)",
      description:
        "Dial the planned candidates in waves until the need is met. PLACES REAL PHONE CALLS in live mode. Requires confirm=true and a find_request_id from shortline_plan_find. Blocks until the request finishes.",
      inputSchema: {
        find_request_id: z.string(),
        confirm: z.boolean().describe("Must be true. The user must have approved the plan."),
        ignore_calling_window: z.boolean().optional().describe("Dry-run only: ignore local calling hours.")
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true }
    },
    async ({ find_request_id, confirm, ignore_calling_window }) => {
      if (confirm !== true) {
        return text({ error: "confirm_required", message: "Ask the user to approve the plan, then call again with confirm=true." });
      }
      try {
        const result = await runFind(ctx, find_request_id, { confirm: true, ignoreWindow: Boolean(ignore_calling_window) });
        return text({ mode: ctx.config.mode, ...describeFind(ctx, result) });
      } catch (error) {
        return text({ error: error instanceof Error ? error.message : String(error) });
      }
    }
  );

  server.registerTool(
    "shortline_get_find",
    {
      title: "Read a sourcing request",
      description: "Read the current state of a sourcing request: confirmed sources with evidence quotes and every attempt with its verdict. Read-only.",
      inputSchema: { find_request_id: z.string() },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
    },
    async ({ find_request_id }) => {
      const request = ctx.repo.getFind(find_request_id);
      return request ? text(describeFind(ctx, request)) : text({ error: "find_not_found" });
    }
  );

  return server;
}

export async function serveMcp(ctx: AppContext): Promise<void> {
  const server = buildMcpServer(ctx);
  await server.connect(new StdioServerTransport());
}

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CalleAPIError, CalleClient } from "@call-e/calle";
import { exportEvidence } from "./app/evidence.js";
import { createContext } from "./app/context.js";
import { recomputeEstimate } from "./app/estimate.js";
import { describeFind, planFind, runFind } from "./app/find.js";
import { reconcilePending } from "./app/poller.js";
import { loadSites, loadWatches, simulateHistory } from "./app/seed.js";
import { runSweep } from "./app/sweep.js";
import { serveMcp } from "./mcp/server.js";
import { assertE164, isValidTimezone, maskDeep, maskPhone } from "./domain/index.js";
import { productLabel } from "./domain/task.js";
import { isoWeek } from "./domain/time.js";
import type { Site } from "./domain/types.js";
import { startServer } from "./server/http.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = existsSync(join(here, "..", "fixtures")) ? join(here, "..") : join(here, "..", "..");

interface Args {
  command: string;
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? "";
    if (!arg.startsWith("--")) {
      continue;
    }
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

function str(flags: Args["flags"], key: string, fallback?: string): string {
  const v = flags[key];
  if (typeof v === "string") {
    return v;
  }
  if (fallback !== undefined) {
    return fallback;
  }
  throw new Error(`--${key} is required`);
}

function num(flags: Args["flags"], key: string, fallback: number): number {
  const v = flags[key];
  return typeof v === "string" ? Number(v) : fallback;
}

function out(value: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(maskDeep(value), null, 2)}\n`);
  } else if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(maskDeep(value), null, 2)}\n`);
  }
}

const HELP = `shortline — phone calls as a statistical sensor network for drug shortages

  shortline auth-check                             read-only credential check (GET /v1/goals?limit=1); never dials

  shortline init [--sites fixtures/sites.sample.json] [--watches fixtures/watches.sample.json]
  shortline demo [--weeks 8] [--no-serve]        dry-run: load fixtures, simulate history, open the dashboard
  shortline serve                                  dashboard + webhook receiver + recovery poller
  shortline sweep --watch ID [--week 2026-W37] [--wait] [--force]
  shortline estimate --watch ID [--week 2026-W37]
  shortline find --watch ID --region US-CA-SF [--need 2] [--wave 3] [--max-waves 4] [--ask-hold] [--ignore-window (dry-run only)] [--only-site ID[,ID]] [--yes]
  shortline reconcile                              replay ambiguous submissions, drain the webhook inbox
  shortline sites [--region CODE]
  shortline site add --id ID --name NAME --kind independent --phone +1... --region CODE --tz America/Los_Angeles [--lat --lng] [--test-line]
      --test-line marks your own phone: exempt from calling windows and cooldowns, never sampled, never counted in the index
  shortline watch add --id ID --name NAME [--strength S] [--form F] --regions US-CA-SF,US-CA-EB [--panel 3] [--cooldown 14] [--gap 5] [--window-start 10:00] [--window-end 17:00] [--min-usable 6]
  shortline opt-out --site ID [--undo [--override-callee]] [--reason TEXT]
  shortline evidence --dispatch ID [--out docs/evidence]   export a masked call snapshot, events, and observations for the record
  shortline mcp                                    MCP server over stdio

Every command is dry-run unless SHORTLINE_MODE=live, CALLE_API_KEY and SHORTLINE_LIVE_ACK are all set.
`;

function assertNodeVersion(): void {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`Node.js 22.13 or newer is required for node:sqlite (running ${process.versions.node})`);
  }
}

async function main(): Promise<void> {
  assertNodeVersion();
  const { command, flags } = parseArgs(process.argv.slice(2));
  const json = Boolean(flags.json);
  if (command === "help" || command === "--help" || command === "-h") {
    out(HELP, false);
    return;
  }
  const ctx = createContext();
  const modeLine = ctx.config.mode === "live" ? "MODE: LIVE — real calls, real money" : "MODE: dry-run — no call can be placed";

  switch (command) {
    case "init": {
      const sites = loadSites(ctx, str(flags, "sites", join(root, "fixtures", "sites.sample.json")));
      const watches = loadWatches(ctx, str(flags, "watches", join(root, "fixtures", "watches.sample.json")));
      out({ sites, watches, db: ctx.config.dbPath }, json);
      return;
    }
    case "demo": {
      if (ctx.config.mode === "live") {
        throw new Error("demo only runs in dry-run mode");
      }
      loadSites(ctx, join(root, "fixtures", "sites.sample.json"));
      loadWatches(ctx, join(root, "fixtures", "watches.sample.json"));
      const weeks = num(flags, "weeks", 8);
      const watch = ctx.repo.listWatches().find((w) => w.status === "active");
      if (!watch) {
        throw new Error("no active watch in fixtures");
      }
      const existing = ctx.repo.listEstimates(watch.id);
      if (existing.length === 0) {
        process.stderr.write(`${modeLine}\nSimulating ${weeks} weeks of sweeps for ${productLabel(watch.product)}...\n`);
        const done = await simulateHistory(ctx, watch.id, weeks);
        process.stderr.write(`Simulated weeks: ${done.join(", ")}\n`);
      } else {
        process.stderr.write(`${modeLine}\nHistory already present (${existing.length} weeks); not re-simulating.\n`);
      }
      if (flags["no-serve"]) {
        out({ ok: true, weeks: ctx.repo.listEstimates(watch.id).length }, json);
        return;
      }
      const server = startServer(ctx);
      process.stderr.write(`Dashboard: http://127.0.0.1:${server.port}/\n`);
      await new Promise(() => undefined);
      return;
    }
    case "serve": {
      const server = startServer(ctx);
      process.stderr.write(`${modeLine}\nDashboard: http://127.0.0.1:${server.port}/${ctx.config.authToken ? "?token=<SHORTLINE_AUTH_TOKEN>" : ""}\n`);
      if (ctx.config.publicUrl) {
        process.stderr.write(`Webhook receiver: ${ctx.config.publicUrl}/webhooks/calle\n`);
      } else {
        process.stderr.write(`No SHORTLINE_PUBLIC_URL set; results are collected by polling.\n`);
      }
      await new Promise(() => undefined);
      return;
    }
    case "sweep": {
      const watch = ctx.repo.getWatch(str(flags, "watch"));
      if (!watch) {
        throw new Error("watch not found; run `shortline init` first");
      }
      process.stderr.write(`${modeLine}\n`);
      const summary = await runSweep(ctx, watch, {
        ...(typeof flags.week === "string" ? { isoWeek: flags.week } : {}),
        wait: Boolean(flags.wait),
        force: Boolean(flags.force)
      });
      out(
        {
          sweep: summary.sweep.id,
          week: summary.sweep.isoWeek,
          status: summary.sweep.status,
          planned: summary.planned,
          alreadyDispatched: summary.alreadyDispatched,
          dispatchedNow: summary.dispatchedNow,
          waitingForWindow: summary.waitingForWindow,
          undersampledStrata: summary.undersampled,
          dispatchIds: summary.dispatchIds,
          excluded: summary.excluded.length
        },
        json
      );
      return;
    }
    case "estimate": {
      const watchId = str(flags, "watch");
      const week = str(flags, "week", isoWeek(ctx.now()));
      out(recomputeEstimate(ctx, watchId, week), json);
      return;
    }
    case "find": {
      const watchId = str(flags, "watch");
      const preview = planFind(ctx, {
        watchId,
        region: str(flags, "region"),
        need: num(flags, "need", 2),
        waveSize: num(flags, "wave", 3),
        maxWaves: num(flags, "max-waves", 4),
        askHold: Boolean(flags["ask-hold"]),
        ignoreWindow: Boolean(flags["ignore-window"]),
        ...(typeof flags["only-site"] === "string" ? { onlySiteIds: flags["only-site"].split(",").map((s) => s.trim()).filter(Boolean) } : {})
      });
      process.stderr.write(`${modeLine}\n`);
      out(
        {
          findRequestId: preview.request.id,
          product: productLabel(preview.request.product),
          need: preview.request.need,
          knownSources: preview.knownSources,
          candidates: preview.candidates,
          skipped: preview.skipped,
          estimatedCalls: preview.estimatedCalls
        },
        json
      );
      if (!flags.yes) {
        process.stderr.write(`\nPlan only. Re-run with --yes to place ${preview.estimatedCalls} call(s), or run: shortline find-run --id ${preview.request.id}\n`);
        return;
      }
      const result = await runFind(ctx, preview.request.id, { confirm: true, ignoreWindow: Boolean(flags["ignore-window"]) });
      out(describeFind(ctx, result), json);
      return;
    }
    case "find-run": {
      const result = await runFind(ctx, str(flags, "id"), { confirm: true, ignoreWindow: Boolean(flags["ignore-window"]) });
      out(describeFind(ctx, result), json);
      return;
    }
    case "reconcile": {
      out(await reconcilePending(ctx), json);
      return;
    }
    case "sites": {
      const region = typeof flags.region === "string" ? flags.region : null;
      const rows = ctx.repo
        .listSites()
        .filter((s) => !region || s.region === region)
        .map((s) => `${s.id.padEnd(12)} ${s.region.padEnd(9)} ${s.kind.padEnd(12)} ${maskPhone(s.phone).padEnd(16)} ${s.optOut ? "OPT-OUT " : "        "} ${s.name}`);
      out(json ? ctx.repo.listSites().map((s) => ({ ...s, phone: maskPhone(s.phone) })) : rows.join("\n"), json);
      return;
    }
    case "site": {
      if (process.argv[3] !== "add") {
        throw new Error("usage: shortline site add --id ... --name ... --kind ... --phone ... --region ... --tz ...");
      }
      const tz = str(flags, "tz");
      if (!isValidTimezone(tz)) {
        throw new Error(`invalid IANA timezone: ${tz}`);
      }
      const site: Site = {
        id: str(flags, "id"),
        name: str(flags, "name"),
        kind: str(flags, "kind", "independent") as Site["kind"],
        phone: assertE164(str(flags, "phone")),
        region: str(flags, "region"),
        timezone: tz,
        source: { kind: "manual", ref: "cli" },
        optOut: false,
        createdAt: ctx.now().toISOString()
      };
      if (typeof flags.lat === "string" && typeof flags.lng === "string") {
        site.lat = Number(flags.lat);
        site.lng = Number(flags.lng);
      }
      if (typeof flags.scenario === "string") {
        site.scenario = flags.scenario;
      }
      if (flags["test-line"]) {
        site.testLine = true;
      }
      ctx.repo.upsertSite(site);
      out({ ok: true, site: { ...site, phone: maskPhone(site.phone) } }, json);
      return;
    }
    case "auth-check": {
      if (!ctx.config.calleApiKey) {
        throw new Error("CALLE_API_KEY is not set");
      }
      // Read-only and through the official SDK: the same client, base URL, and Bearer header a sweep would use.
      const clientOptions: { apiKey: string; baseUrl?: string } = { apiKey: ctx.config.calleApiKey };
      if (ctx.config.calleBaseUrl) {
        clientOptions.baseUrl = ctx.config.calleBaseUrl;
      }
      const client = new CalleClient(clientOptions);
      try {
        const goals = await client.goals.list({ limit: 1 });
        out({ ok: true, status: 200, mode: ctx.config.mode, goals_visible: goals.data.length, sdk: "@call-e/calle" }, json);
      } catch (error) {
        const code = error instanceof CalleAPIError ? error.code : "transport";
        const status = error instanceof CalleAPIError ? error.status : null;
        out({ ok: false, status, mode: ctx.config.mode, error: code, message: error instanceof Error ? error.message : String(error) }, json);
        process.exit(1);
      }
      return;
    }
    case "watch": {
      if (process.argv[3] !== "add") {
        throw new Error("usage: shortline watch add --id ... --name ... --regions A,B");
      }
      const id = str(flags, "id");
      const existing = ctx.repo.getWatch(id);
      const product: { name: string; strength?: string; form?: string } = { name: str(flags, "name") };
      if (typeof flags.strength === "string") {
        product.strength = flags.strength;
      }
      if (typeof flags.form === "string") {
        product.form = flags.form;
      }
      ctx.repo.upsertWatch({
        id,
        product,
        regions: str(flags, "regions").split(",").map((r) => r.trim()).filter(Boolean),
        panelPerStratum: num(flags, "panel", 3),
        cooldownDays: num(flags, "cooldown", 14),
        globalMinGapDays: num(flags, "gap", 5),
        window: { start: str(flags, "window-start", "10:00"), end: str(flags, "window-end", "17:00"), days: [1, 2, 3, 4, 5, 6] },
        thresholds: { shortageUpper: 0.5, strainedPoint: 0.7 },
        minUsable: num(flags, "min-usable", 6),
        status: "active",
        createdAt: existing?.createdAt ?? ctx.now().toISOString()
      });
      out({ ok: true, watch: ctx.repo.getWatch(id) }, json);
      return;
    }
    case "opt-out": {
      const id = str(flags, "site");
      const result = ctx.repo.setOptOut(id, !flags.undo, typeof flags.reason === "string" ? flags.reason : "operator", { overrideCallee: Boolean(flags["override-callee"]) });
      if (!result.ok) {
        throw new Error(`${id} asked not to be called (${result.reason}); re-run with --override-callee only if that request was withdrawn`);
      }
      out({ ok: true, site: id, optOut: !flags.undo }, json);
      return;
    }
    case "evidence": {
      const dispatchId = str(flags, "dispatch");
      const dir = str(flags, "out", join(root, "docs", "evidence"));
      const bundle = await exportEvidence(ctx, dispatchId);
      const target = join(dir, `${bundle.exportedAt.slice(0, 10)}-${dispatchId}`);
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, "call.json"), `${JSON.stringify(bundle.call, null, 2)}\n`);
      writeFileSync(join(target, "events.json"), `${JSON.stringify(bundle.events, null, 2)}\n`);
      writeFileSync(join(target, "observations.json"), `${JSON.stringify(bundle.observations, null, 2)}\n`);
      writeFileSync(join(target, "README.md"), bundle.readme);
      out({ ok: true, dir: target, callId: bundle.call.id, mode: bundle.mode, recipients: bundle.call.recipients.length }, json);
      return;
    }
    case "mcp": {
      await serveMcp(ctx);
      await new Promise(() => undefined);
      return;
    }
    default:
      throw new Error(`unknown command: ${command}\n${HELP}`);
  }
}

main().catch((error: Error) => {
  process.stderr.write(`error: ${error.message}\n`);
  process.exit(1);
});

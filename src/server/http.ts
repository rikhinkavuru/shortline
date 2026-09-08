import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import type { AppContext } from "../app/context.js";
import { planFind, runFind } from "../app/find.js";
import { reconcilePending, startPolling } from "../app/poller.js";
import { runSweep } from "../app/sweep.js";
import { handleWebhook } from "../app/webhook.js";
import { maskDeep } from "../domain/phone.js";
import { snapshotState } from "./state.js";

const here = dirname(fileURLToPath(import.meta.url));

/** In instant dry-run mode the fake completes synchronously; await so serverless hosts never drop the work. */
function instant(ctx: AppContext): boolean {
  return ctx.provider.mode === "fake" && ctx.config.fakePaceMs === 0;
}

function asset(name: string): string {
  return readFileSync(join(here, "ui", name), "utf8");
}

export function createApp(ctx: AppContext): Hono {
  const app = new Hono();
  const token = ctx.config.authToken;

  app.use("*", async (c, next) => {
    if (c.req.path === "/webhooks/calle" || c.req.path === "/healthz") {
      return next();
    }
    if (!token) {
      return next();
    }
    const query = c.req.query("token");
    if (query && query === token) {
      setCookie(c, "shortline_auth", token, { httpOnly: true, sameSite: "Lax", path: "/" });
      return next();
    }
    const header = c.req.header("authorization") ?? "";
    if (header === `Bearer ${token}` || getCookie(c, "shortline_auth") === token) {
      return next();
    }
    return c.json({ error: "unauthorized" }, 401);
  });

  app.get("/healthz", (c) => c.json({ ok: true, mode: ctx.config.mode }));
  app.get("/", (c) => c.html(asset("index.html")));
  app.get("/app.js", (c) => c.body(asset("app.js"), 200, { "content-type": "text/javascript; charset=utf-8" }));
  app.get("/styles.css", (c) => c.body(asset("styles.css"), 200, { "content-type": "text/css; charset=utf-8" }));

  app.get("/api/state", (c) => c.json(maskDeep(snapshotState(ctx, c.req.query("watch") ?? null))));

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      let alive = true;
      const unsubscribe = ctx.bus.subscribe((entry) => {
        if (alive) {
          void stream.writeSSE({ event: "app", data: JSON.stringify(maskDeep(entry)) });
        }
      });
      stream.onAbort(() => {
        alive = false;
        unsubscribe();
      });
      await stream.writeSSE({ event: "hello", data: JSON.stringify({ mode: ctx.config.mode }) });
      while (alive) {
        await stream.sleep(15000);
        await stream.writeSSE({ event: "ping", data: "{}" });
      }
    })
  );

  app.post("/api/sweeps/run", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { watchId?: string; force?: boolean };
    const watch = body.watchId ? ctx.repo.getWatch(body.watchId) : null;
    if (!watch) {
      return c.json({ error: "watch_not_found" }, 404);
    }
    const force = Boolean(body.force) && ctx.config.mode !== "live";
    const run = runSweep(ctx, watch, { wait: true, force }).catch((error: Error) => ctx.bus.emit({ type: "notice", level: "warn", message: `sweep failed: ${error.message}` }));
    if (instant(ctx)) {
      await run;
    }
    return c.json({ started: true });
  });

  app.post("/api/find/plan", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const preview = planFind(ctx, {
        ...(typeof body.watchId === "string" ? { watchId: body.watchId } : {}),
        region: String(body.region ?? ""),
        ...(typeof body.need === "number" ? { need: body.need } : {}),
        ...(typeof body.waveSize === "number" ? { waveSize: body.waveSize } : {}),
        ...(typeof body.maxWaves === "number" ? { maxWaves: body.maxWaves } : {}),
        askHold: Boolean(body.askHold),
        ignoreWindow: Boolean(body.ignoreWindow) && ctx.config.mode !== "live",
        ...(body.near && typeof body.near === "object" ? { near: body.near as { lat: number; lng: number } } : {}),
        ...(Array.isArray(body.onlySiteIds) && body.onlySiteIds.length > 0 ? { onlySiteIds: (body.onlySiteIds as unknown[]).filter((v): v is string => typeof v === "string").slice(0, 20) } : {})
      });
      return c.json(maskDeep(preview));
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/find/:id/run", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { confirm?: boolean; ignoreWindow?: boolean };
    if (body.confirm !== true) {
      return c.json({ error: "confirm_required" }, 400);
    }
    const id = c.req.param("id");
    if (!ctx.repo.getFind(id)) {
      return c.json({ error: "find_not_found" }, 404);
    }
    const run = runFind(ctx, id, { confirm: true, ignoreWindow: Boolean(body.ignoreWindow) && ctx.config.mode !== "live" }).catch((error: Error) =>
      ctx.bus.emit({ type: "notice", level: "warn", message: `find ${id} failed: ${error.message}` })
    );
    if (instant(ctx)) {
      await run;
    }
    return c.json({ started: true });
  });

  app.get("/api/transcript", (c) => {
    const dispatch = c.req.query("dispatch") ?? "";
    const recipient = c.req.query("recipient") ?? "";
    const turns = ctx.repo.getTranscript(dispatch, recipient);
    return turns ? c.json({ turns: maskDeep(turns) }) : c.json({ error: "not_found" }, 404);
  });

  app.post("/api/sites/:id/opt-out", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { optOut?: boolean; reason?: string };
    const id = c.req.param("id");
    if (!ctx.repo.getSite(id)) {
      return c.json({ error: "site_not_found" }, 404);
    }
    ctx.repo.setOptOut(id, body.optOut !== false, body.reason ?? "operator");
    ctx.bus.emit({ type: "notice", level: "info", message: `${id} ${body.optOut !== false ? "opted out" : "opted back in"}` });
    return c.json({ ok: true });
  });

  app.post("/api/reconcile", async (c) => c.json(await reconcilePending(ctx)));

  app.post("/webhooks/calle", async (c) => {
    const raw = await c.req.text();
    const outcome = handleWebhook(ctx, raw, c.req.header("CALL-E-Event-Id") ?? null);
    return c.json(outcome.body, outcome.status as 200 | 400);
  });

  return app;
}

export function startServer(ctx: AppContext): { stop: () => Promise<void>; port: number } {
  if (ctx.config.mode === "live" && !ctx.config.authToken) {
    throw new Error("SHORTLINE_MODE=live refuses to serve without SHORTLINE_AUTH_TOKEN");
  }
  const app = createApp(ctx);
  const server = serve({ fetch: app.fetch, port: ctx.config.port, hostname: process.env.SHORTLINE_HOST ?? "127.0.0.1" });
  const stopPolling = startPolling(ctx, ctx.config.pollIntervalMs);
  return {
    port: ctx.config.port,
    stop: () =>
      new Promise<void>((resolve) => {
        stopPolling();
        server.close(() => resolve());
      })
  };
}

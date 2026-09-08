import { handle } from "hono/vercel";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/app/config.js";
import { createContext } from "../src/app/context.js";
import { loadSites, loadWatches, simulateHistory } from "../src/app/seed.js";
import { createApp } from "../src/server/http.js";

/**
 * Hosted dry-run demo. Every cold start seeds the fixtures and simulates
 * eight weeks; nothing here can place a call because the provider is the
 * in-process fake regardless of environment.
 */
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const config = loadConfig({ SHORTLINE_MODE: "dry-run", SHORTLINE_DB: "/tmp/shortline-demo.sqlite", SHORTLINE_FAKE_PACE_MS: "0" });
const ctx = createContext({ config });

let seeded: Promise<void> | null = null;
function ensureSeeded(): Promise<void> {
  if (!seeded) {
    seeded = (async () => {
      loadSites(ctx, join(root, "fixtures", "sites.sample.json"));
      loadWatches(ctx, join(root, "fixtures", "watches.sample.json"));
      const watch = ctx.repo.listWatches().find((w) => w.status === "active");
      if (watch && ctx.repo.listEstimates(watch.id).length === 0) {
        await simulateHistory(ctx, watch.id, 8);
      }
    })();
  }
  return seeded;
}

const app = createApp(ctx);
const handler = handle(app);

async function serve(request: Request): Promise<Response> {
  await ensureSeeded();
  return handler(request);
}

export const GET = serve;
export const POST = serve;
export const PUT = serve;
export const PATCH = serve;
export const DELETE = serve;
export const OPTIONS = serve;

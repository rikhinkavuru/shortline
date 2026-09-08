import { FakeCalleProvider } from "../calle/fake.js";
import { LiveCalleProvider } from "../calle/live.js";
import type { CallProvider } from "../calle/provider.js";
import { openDb } from "../store/db.js";
import { Repo } from "../store/repo.js";
import { Bus } from "./bus.js";
import { type Config, loadConfig } from "./config.js";

export interface AppContext {
  config: Config;
  repo: Repo;
  provider: CallProvider;
  bus: Bus;
  /** Mutable clock so history can be simulated deterministically. */
  now: () => Date;
}

export function createContext(overrides: Partial<{ config: Config; provider: CallProvider; now: () => Date; repo: Repo }> = {}): AppContext {
  const config = overrides.config ?? loadConfig();
  const repo = overrides.repo ?? new Repo(openDb(config.dbPath));
  const bus = new Bus();
  let clock = overrides.now ?? (() => new Date());
  const ctx: AppContext = {
    config,
    repo,
    bus,
    provider: undefined as unknown as CallProvider,
    now: () => clock()
  };
  Object.defineProperty(ctx, "setClock", { value: (fn: () => Date) => (clock = fn), enumerable: false });
  if (overrides.provider) {
    ctx.provider = overrides.provider;
  } else if (config.mode === "live") {
    const options: { apiKey: string; baseUrl?: string } = { apiKey: config.calleApiKey ?? "" };
    if (config.calleBaseUrl) {
      options.baseUrl = config.calleBaseUrl;
    }
    ctx.provider = new LiveCalleProvider(options);
  } else {
    ctx.provider = new FakeCalleProvider({
      speed: config.fakePaceMs > 0 ? { queueMs: config.fakePaceMs, ringMs: config.fakePaceMs, talkMs: config.fakePaceMs * 2 } : "instant",
      resolver: (phone) => repo.getSiteByPhone(phone)?.scenario,
      clock: () => ctx.now()
    });
  }
  return ctx;
}

export function setClock(ctx: AppContext, fn: () => Date): void {
  (ctx as unknown as { setClock: (f: () => Date) => void }).setClock(fn);
}

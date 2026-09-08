export type Mode = "dry-run" | "live";

export interface Config {
  mode: Mode;
  dbPath: string;
  port: number;
  publicUrl: string | null;
  authToken: string | null;
  calleApiKey: string | null;
  calleBaseUrl: string | null;
  liveAck: boolean;
  keepTranscriptsDays: number;
  callerName: string;
  /** Milliseconds per fake call stage in dry-run mode; 0 means instant. */
  fakePaceMs: number;
  /** Max recipients per CALL-E call task. */
  batchSize: number;
  pollIntervalMs: number;
}

export const LIVE_ACK_PHRASE = "I_UNDERSTAND_REAL_CALLS_COST_MONEY_AND_CANNOT_BE_RECALLED";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const mode: Mode = env.SHORTLINE_MODE === "live" ? "live" : "dry-run";
  const config: Config = {
    mode,
    dbPath: env.SHORTLINE_DB ?? "./data/shortline.sqlite",
    port: Number(env.SHORTLINE_PORT ?? 8787),
    publicUrl: env.SHORTLINE_PUBLIC_URL?.replace(/\/$/, "") ?? null,
    authToken: env.SHORTLINE_AUTH_TOKEN ?? null,
    calleApiKey: env.CALLE_API_KEY ?? null,
    calleBaseUrl: env.CALLE_BASE_URL ?? null,
    liveAck: env.SHORTLINE_LIVE_ACK === LIVE_ACK_PHRASE,
    keepTranscriptsDays: Number(env.SHORTLINE_KEEP_TRANSCRIPTS_DAYS ?? 14),
    callerName: env.SHORTLINE_CALLER_NAME ?? "Shortline",
    fakePaceMs: Number(env.SHORTLINE_FAKE_PACE_MS ?? 0),
    batchSize: Math.max(1, Math.min(20, Number(env.SHORTLINE_BATCH_SIZE ?? 6))),
    pollIntervalMs: Number(env.SHORTLINE_POLL_INTERVAL_MS ?? 5000)
  };
  if (mode === "live") {
    const missing: string[] = [];
    if (!config.calleApiKey) {
      missing.push("CALLE_API_KEY");
    }
    if (!config.liveAck) {
      missing.push(`SHORTLINE_LIVE_ACK=${LIVE_ACK_PHRASE}`);
    }
    if (missing.length > 0) {
      throw new Error(`SHORTLINE_MODE=live refuses to start without: ${missing.join(", ")}`);
    }
  }
  return config;
}

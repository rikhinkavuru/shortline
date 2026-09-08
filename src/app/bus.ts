import { EventEmitter } from "node:events";

export type AppEvent =
  | { type: "dispatch"; dispatchId: string; state: string; callId: string | null; kind: string; siteIds: string[]; note: string | null }
  | { type: "observation"; observationId: string; siteId: string; siteName: string; outcome: string; usable: boolean; usableReason: string; evidenceQuote: string; source: string; watchId: string | null; findRequestId: string | null }
  | { type: "estimate"; watchId: string; isoWeek: string; signal: string; pHat: number | null }
  | { type: "call_event"; callId: string; eventType: string; message: string; details: Record<string, unknown> }
  | { type: "find"; findRequestId: string; status: string; confirmed: number; need: number }
  | { type: "sweep"; sweepId: string; watchId: string; isoWeek: string; status: string; note: string }
  | { type: "notice"; level: "info" | "warn"; message: string };

export class Bus {
  private readonly emitter = new EventEmitter();
  private readonly recent: Array<{ at: string; event: AppEvent }> = [];

  emit(event: AppEvent): void {
    const entry = { at: new Date().toISOString(), event };
    this.recent.push(entry);
    if (this.recent.length > 500) {
      this.recent.shift();
    }
    this.emitter.emit("event", entry);
  }

  subscribe(listener: (entry: { at: string; event: AppEvent }) => void): () => void {
    this.emitter.on("event", listener);
    return () => this.emitter.off("event", listener);
  }

  history(limit = 200): Array<{ at: string; event: AppEvent }> {
    return this.recent.slice(-limit);
  }
}

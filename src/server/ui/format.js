// Text formatting helpers. Everything that ends up inside HTML goes through esc().

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export const fmtPct = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? "—" : `${Math.round(Number(v) * 100)}%`);

/** "a–b" interval in percent. */
export const fmtInterval = (low, high) => (low === null || low === undefined || high === null || high === undefined ? "—" : `${Math.round(low * 100)}–${Math.round(high * 100)}%`);

export const weekShort = (isoWeek) => (isoWeek ? String(isoWeek).replace(/^\d{4}-/, "") : "");

const DAY = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Compact day list: contiguous runs become "Mon–Sat", gaps become commas. */
export function dayList(days) {
  const list = (days ?? []).map(Number).filter((d) => d >= 1 && d <= 7).sort((a, b) => a - b);
  if (!list.length) return "";
  const runs = [];
  let start = list[0];
  let prev = list[0];
  for (const d of list.slice(1)) {
    if (d === prev + 1) {
      prev = d;
      continue;
    }
    runs.push([start, prev]);
    start = d;
    prev = d;
  }
  runs.push([start, prev]);
  return runs.map(([a, b]) => (a === b ? DAY[a] : b === a + 1 ? `${DAY[a]}, ${DAY[b]}` : `${DAY[a]}–${DAY[b]}`)).join(", ");
}

/** Window hint sentence, values from state. Mode-specific ending appended by the caller. */
export function windowHint(d) {
  if (!d || !d.localNow || !d.window) return "";
  const day = DAY[d.localNow.isoWeekday] ?? "";
  return `It is ${d.localNow.hhmm} ${day} in ${d.localNow.timezone}; calls go out ${d.window.start}–${d.window.end} local, ${dayList(d.window.days)}.`;
}

export function windowHintFull(d) {
  const base = windowHint(d);
  if (!base) return "";
  return `${base} ${d.mode === "live" ? "The next run inside the window will dial." : "Tick Ignore calling hours to simulate now."}`;
}

/** Time-of-day greeting from the site clock, never the browser clock. */
export function greeting(localNow, operatorName) {
  let word = "Hello";
  if (localNow) {
    const minutes = typeof localNow.minutesOfDay === "number" ? localNow.minutesOfDay : parseHHMM(localNow.hhmm);
    if (minutes !== null) {
      const h = Math.floor(minutes / 60);
      word = h >= 5 && h < 12 ? "Good morning" : h >= 12 && h < 17 ? "Good afternoon" : "Good evening";
    }
  }
  const name = String(operatorName ?? "").trim();
  return name ? `${word}, ${name}` : word;
}

function parseHHMM(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export const productLabel = (p) => (p ? [p.name, p.strength, p.form].filter(Boolean).join(" ") : "");

let zone = null;
/** Set the display time zone (the site zone from state.localNow.timezone). */
export function setDisplayZone(tz) {
  zone = tz || null;
}
export function displayZone() {
  return zone;
}

function fmt(iso, opts) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  try {
    return new Intl.DateTimeFormat(undefined, { ...opts, ...(zone ? { timeZone: zone } : {}) }).format(d);
  } catch {
    return new Intl.DateTimeFormat(undefined, opts).format(d);
  }
}

export const clock = (iso) => fmt(iso, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
export const fmtTime = (iso) => (iso ? fmt(iso, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
export const fmtDateTime = (iso) => (iso ? fmt(iso, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short" }) : "");

/** Relative age against a reference instant (state.now), falling back to the browser clock. */
export function rel(iso, ref) {
  if (!iso) return "never";
  const then = new Date(iso).getTime();
  const now = ref ? new Date(ref).getTime() : Date.now();
  if (Number.isNaN(then) || Number.isNaN(now)) return "—";
  const ms = Math.max(0, now - then);
  const min = Math.round(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(ms / 3600000);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const OUTCOME = {
  in_stock: "in stock",
  limited: "limited",
  out_of_stock: "out of stock",
  not_carried: "not carried",
  refused: "refused",
  unknown: "unknown",
  voicemail: "voicemail",
  ivr_dead_end: "menu dead end",
  not_reached: "not reached",
  unreachable: "unreachable"
};
export const humanOutcome = (o) => OUTCOME[o] ?? String(o ?? "").replace(/_/g, " ");

const REASON = {
  verified: "verified against transcript",
  quoted_without_transcript: "quote, no transcript",
  no_structured_result: "no result extracted",
  recipient_failed: "call failed",
  recipient_skipped: "skipped by CALL-E",
  recipient_pending: "never dialled",
  recipient_in_progress: "still in progress",
  not_dialled: "never dialled",
  voicemail: "voicemail",
  ivr_only: "never left the menu",
  pharmacy_not_reached: "pharmacy staff not reached",
  refused: "declined to share",
  no_clear_answer: "no clear answer",
  pharmacy_staff_not_confirmed: "staff not confirmed",
  not_in_frame: "does not carry; removed from frame",
  product_never_asked: "product never named",
  no_evidence: "no evidence quote",
  evidence_unattributed: "quote not in transcript"
};
export const humanReason = (r) => REASON[r] ?? String(r ?? "").replace(/_/g, " ");

const SKIP = {
  opted_out: "opted out",
  does_not_carry: "does not carry",
  wrong_number: "wrong number",
  call_in_flight: "call in flight",
  outside_calling_window: "outside calling window",
  called_in_last_24h: "called in the last 24 h",
  observed_out_of_stock_recently: "out of stock recently",
  known_source_no_call_needed: "known source, no call needed"
};
export const humanSkip = (r) => SKIP[r] ?? String(r ?? "").replace(/_/g, " ");

const BASIS = { unknown: "unknown", observed_in_stock: "observed in stock", observed_out: "observed out" };
export const humanBasis = (b) => BASIS[b] ?? String(b ?? "").replace(/_/g, " ");

export const humanMethod = (m) => ({ stratified: "Stratified", pooled_wilson: "Pooled Wilson" }[m] ?? String(m ?? "—"));
export const methodExplainer = (m) =>
  ({
    stratified: "Each region-and-kind stratum is estimated on its own, weighted by how many sites it has, then combined with a finite-population correction. The interval uses the effective sample size.",
    pooled_wilson: "A stratum had fewer than two usable answers, so every usable answer was pooled into one Wilson interval instead of weighting strata."
  }[m] ?? "How the weekly estimate is computed.");

export const SIGNAL_LABEL = { available: "Available", strained: "Strained", shortage: "Shortage", insufficient_data: "Insufficient data" };
export const humanSignal = (s) => SIGNAL_LABEL[s] ?? String(s ?? "").replace(/_/g, " ");

export const DISPATCH_STATE = {
  reserved: "reserved",
  accepted: "accepted by CALL-E",
  submission_unknown: "submission unknown, will reconcile",
  terminal_unverified: "call ended, verifying",
  terminal_verified: "verified",
  needs_human: "needs human"
};
export const humanDispatchState = (s) => DISPATCH_STATE[s] ?? String(s ?? "").replace(/_/g, " ");

export const FIND_EVENT_STATUS = { planned: "planned", running: "calling", met: "found", exhausted: "no source found", needs_human: "stopped, needs a human look", stopped: "discarded" };

export function findStatusLabel(f) {
  const r = f.request ?? {};
  if (r.status === "met") return "Found";
  if (r.status === "running") return "Calling…";
  if (r.status === "exhausted") return `No source found after ${f.waves} wave${f.waves === 1 ? "" : "s"}`;
  if (r.status === "needs_human") return `Stopped, needs a human look${f.halt?.note ? `: ${f.halt.note}` : ""}`;
  if (r.status === "stopped") return "Discarded";
  return String(r.status ?? "");
}

export const normalizePhrase = (t) => String(t ?? "").toLowerCase().replace(/[’'`]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

export const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

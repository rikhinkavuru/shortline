import type { CallWindow } from "./types.js";

/** ISO 8601 week label such as `2026-W37`, computed in UTC. */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Monday 00:00 UTC of the given ISO week label. */
export function isoWeekStart(label: string): Date {
  const m = /^(\d{4})-W(\d{2})$/.exec(label);
  if (!m) {
    throw new Error(`invalid ISO week label: ${label}`);
  }
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const mondayWeek1 = new Date(jan4.getTime() - (jan4Day - 1) * 86400000);
  return new Date(mondayWeek1.getTime() + (week - 1) * 7 * 86400000);
}

export function addIsoWeeks(label: string, delta: number): string {
  const start = isoWeekStart(label);
  return isoWeek(new Date(start.getTime() + delta * 7 * 86400000 + 3 * 86400000));
}

export interface LocalClock {
  isoWeekday: number;
  minutesOfDay: number;
  hhmm: string;
}

/** Local wall-clock reading for an IANA timezone. Throws on an invalid zone. */
export function localClock(timezone: string, at: Date): LocalClock {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = fmt.formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const weekdayIndex: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
  const weekday = weekdayIndex[get("weekday")];
  if (weekday === undefined) {
    throw new Error(`could not resolve weekday for timezone ${timezone}`);
  }
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  return { isoWeekday: weekday, minutesOfDay: hour * 60 + minute, hhmm: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}` };
}

function parseHHMM(value: string): number {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  if (!m) {
    throw new Error(`invalid HH:MM: ${value}`);
  }
  return Number(m[1]) * 60 + Number(m[2]);
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** True when `at` falls inside the site's local calling window. */
export function withinWindow(timezone: string, window: CallWindow, at: Date): boolean {
  const clock = localClock(timezone, at);
  if (!window.days.includes(clock.isoWeekday)) {
    return false;
  }
  const start = parseHHMM(window.start);
  const end = parseHHMM(window.end);
  return clock.minutesOfDay >= start && clock.minutesOfDay < end;
}

export function daysBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / 86400000;
}

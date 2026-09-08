import { describe, expect, it } from "vitest";
import { isFictionReserved, maskDeep, maskPhone } from "../src/domain/phone.js";
import { addIsoWeeks, isoWeek, isoWeekStart, localClock, withinWindow } from "../src/domain/time.js";

describe("phone", () => {
  it("masks numbers everywhere, including nested objects", () => {
    expect(maskPhone("+14155550123")).toBe("+1 415 ••• 0123");
    expect(maskPhone("+6591234567")).toBe("+65 ••• 4567");
    const masked = maskDeep({ a: "call +14155550123 now", b: ["+14155550199"], c: { d: 1 } });
    expect(masked).toEqual({ a: "call +1 415 ••• 0123 now", b: ["+1 415 ••• 0199"], c: { d: 1 } });
  });
  it("recognises the NANP fiction block", () => {
    expect(isFictionReserved("+14155550123")).toBe(true);
    expect(isFictionReserved("+14155551234")).toBe(false);
  });
});

describe("time", () => {
  it("computes ISO weeks across a year boundary", () => {
    expect(isoWeek(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
    expect(isoWeek(new Date("2027-01-01T00:00:00Z"))).toBe("2026-W53");
    expect(isoWeekStart("2026-W37").toISOString()).toBe("2026-09-07T00:00:00.000Z");
    expect(addIsoWeeks("2026-W01", -1)).toBe("2025-W52");
  });
  it("reads a local clock in an IANA zone and applies the window", () => {
    const clock = localClock("Asia/Singapore", new Date("2026-09-08T02:30:00Z"));
    expect(clock.hhmm).toBe("10:30");
    expect(clock.isoWeekday).toBe(2);
    const window = { start: "10:00", end: "17:00", days: [1, 2, 3, 4, 5] };
    expect(withinWindow("Asia/Singapore", window, new Date("2026-09-08T02:30:00Z"))).toBe(true);
    expect(withinWindow("America/Los_Angeles", window, new Date("2026-09-08T02:30:00Z"))).toBe(false);
  });
  it("rejects an invalid timezone instead of guessing", () => {
    expect(() => localClock("Mars/Olympus", new Date())).toThrow();
  });
});

import { describe, expect, it } from "vitest";

import { checkWindow, describeNow, formatWindow, fromLocal, toLocal } from "./time.js";

const DUBAI = "Asia/Dubai";

describe("fromLocal / toLocal", () => {
  it("converts Dubai wall-clock time, UTC+4", () => {
    expect(fromLocal("2026-09-17T15:00", DUBAI)?.toISOString()).toBe("2026-09-17T11:00:00.000Z");
    expect(toLocal(new Date("2026-09-17T11:00:00Z"), DUBAI)).toBe("2026-09-17T15:00");
  });

  it("handles a half-hour offset", () => {
    expect(fromLocal("2026-09-17T15:00", "Asia/Kolkata")?.toISOString()).toBe("2026-09-17T09:30:00.000Z");
  });

  it("uses the right offset on each side of a daylight-saving change", () => {
    // London is UTC+1 until 25 Oct 2026, then UTC+0.
    expect(fromLocal("2026-10-24T12:00", "Europe/London")?.toISOString()).toBe("2026-10-24T11:00:00.000Z");
    expect(fromLocal("2026-10-26T12:00", "Europe/London")?.toISOString()).toBe("2026-10-26T12:00:00.000Z");
  });

  it("rejects a time skipped by a daylight-saving jump", () => {
    // London clocks jump from 01:00 to 02:00 on 29 Mar 2026.
    expect(fromLocal("2026-03-29T01:30", "Europe/London")).toBeNull();
  });

  it("rejects days that don't exist and malformed strings", () => {
    expect(fromLocal("2026-02-30T10:00", DUBAI)).toBeNull();
    expect(fromLocal("2026-09-17 15:00", DUBAI)).toBeNull();
    expect(fromLocal("tomorrow at 3", DUBAI)).toBeNull();
  });
});

describe("checkWindow", () => {
  const now = new Date("2026-09-17T10:00:00Z"); // 14:00 in Dubai

  it("accepts a window in the future", () => {
    const result = checkWindow("2026-09-18T12:00", "2026-09-18T17:00", DUBAI, now);
    expect(result).toEqual({
      ok: true,
      start: new Date("2026-09-18T08:00:00Z"),
      end: new Date("2026-09-18T13:00:00Z"),
    });
  });

  it("starts a window already under way at now", () => {
    const result = checkWindow("2026-09-17T12:00", "2026-09-17T17:00", DUBAI, now);
    expect(result).toEqual({ ok: true, start: now, end: new Date("2026-09-17T13:00:00Z") });
  });

  it("rejects a window that is already over", () => {
    expect(checkWindow("2026-09-17T08:00", "2026-09-17T12:00", DUBAI, now)).toEqual({ ok: false, problem: "in_past" });
  });

  it("rejects an end before the start", () => {
    expect(checkWindow("2026-09-18T17:00", "2026-09-18T12:00", DUBAI, now)).toEqual({ ok: false, problem: "ends_before_start" });
  });

  it("rejects anything more than two weeks long", () => {
    expect(checkWindow("2026-09-18T00:00", "2026-10-03T00:00", DUBAI, now)).toEqual({ ok: false, problem: "too_long" });
    expect(checkWindow("2026-09-18T00:00", "2026-10-02T00:00", DUBAI, now).ok).toBe(true);
  });

  it("rejects times it can't read", () => {
    expect(checkWindow("tomorrow", "2026-09-18T12:00", DUBAI, now)).toEqual({ ok: false, problem: "unreadable" });
  });
});

describe("formatting", () => {
  it("describes a same-day window compactly", () => {
    expect(formatWindow(new Date("2026-09-18T08:00:00Z"), new Date("2026-09-18T13:00:00Z"), DUBAI)).toBe("Fri 18 Sept, 12:00–17:00");
  });

  it("describes now with the weekday for the model", () => {
    expect(describeNow(new Date("2026-09-17T10:04:00Z"), DUBAI)).toBe("Thursday 2026-09-17 14:04");
  });
});

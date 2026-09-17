import { describe, expect, it } from "vitest";

import {
  daysOfWeekInWindow,
  freeChains,
  freeSlots,
  spreadSlots,
  type AvailabilityInput,
  type BusyAppointment,
  type OpeningHours,
} from "./availability.js";

// 2030-01-04 is a Friday, 01-05 Saturday, 01-06 Sunday, 01-07 Monday.
const FRI = 5;
const SAT = 6;
const MON = 1;

/** A Dubai wall-clock time, e.g. at("2030-01-07T09:00"). */
const at = (local: string) => new Date(`${local}:00+04:00`);

/** Back to Dubai wall-clock, "2030-01-07T09:00". */
const local = (date: Date) =>
  new Date(date.getTime() + 4 * 60 * 60_000).toISOString().slice(0, 16);

const everyDay = (opensAt: string, closesAt: string): OpeningHours[] =>
  [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({ dayOfWeek, opensAt, closesAt }));

const booked = (resourceIndex: number, start: string, end: string): BusyAppointment => ({
  resourceIndex,
  start: at(start),
  end: at(end),
});

function slots(overrides: Partial<Omit<AvailabilityInput, "rules">> & {
  rules?: Partial<AvailabilityInput["rules"]>;
}) {
  const input: AvailabilityInput = {
    now: at("2030-01-01T00:00"),
    window: { start: at("2030-01-07T00:00"), end: at("2030-01-08T00:00") },
    durationMin: 30,
    hours: [{ dayOfWeek: MON, opensAt: "09:00", closesAt: "11:00" }],
    closures: [],
    appointments: [],
    ...overrides,
    rules: {
      capacity: 1,
      slotIntervalMin: 30,
      bufferMin: 0,
      leadTimeMin: 0,
      maxAdvanceDays: 60,
      ...overrides.rules,
    },
  };
  return freeSlots(input);
}

const times = (result: ReturnType<typeof freeSlots>) => result.map((slot) => local(slot.start));

describe("freeSlots — opening hours", () => {
  it("offers a start only when the whole appointment fits before closing", () => {
    expect(times(slots({ durationMin: 60 }))).toEqual([
      "2030-01-07T09:00",
      "2030-01-07T09:30",
      "2030-01-07T10:00",
    ]);
  });

  it("puts starts on the clock grid, not on the opening time", () => {
    const hours = [{ dayOfWeek: MON, opensAt: "09:15", closesAt: "11:00" }];
    expect(times(slots({ hours }))).toEqual([
      "2030-01-07T09:30",
      "2030-01-07T10:00",
      "2030-01-07T10:30",
    ]);
  });

  it("has nothing on a day with no hours row", () => {
    const hours = [{ dayOfWeek: FRI, opensAt: "09:00", closesAt: "17:00" }];
    expect(slots({ hours })).toEqual([]);
  });

  it("reaches Saturday 01:00 through Friday's 18:00–02:00 row", () => {
    const hours = [{ dayOfWeek: FRI, opensAt: "18:00", closesAt: "02:00" }];
    const window = { start: at("2030-01-05T00:00"), end: at("2030-01-05T03:00") };
    expect(times(slots({ hours, window }))).toEqual([
      "2030-01-05T00:00",
      "2030-01-05T00:30",
      "2030-01-05T01:00",
      "2030-01-05T01:30",
    ]);
  });

  it("fits an appointment across midnight inside a late night", () => {
    const hours = [{ dayOfWeek: FRI, opensAt: "18:00", closesAt: "02:00" }];
    const window = { start: at("2030-01-04T23:00"), end: at("2030-01-05T02:00") };
    expect(times(slots({ hours, window, durationMin: 60 }))).toEqual([
      "2030-01-04T23:00",
      "2030-01-04T23:30",
      "2030-01-05T00:00",
      "2030-01-05T00:30",
      "2030-01-05T01:00",
    ]);
  });

  it("treats a business open 00:00–00:00 every day as one continuous range", () => {
    const window = { start: at("2030-01-07T23:00"), end: at("2030-01-08T00:30") };
    expect(times(slots({ hours: everyDay("00:00", "00:00"), window, durationMin: 60 }))).toEqual([
      "2030-01-07T23:00",
      "2030-01-07T23:30",
      "2030-01-08T00:00",
    ]);
  });
});

describe("freeSlots — booking rules", () => {
  it("skips anything inside the lead time", () => {
    const hours = [{ dayOfWeek: MON, opensAt: "09:00", closesAt: "12:00" }];
    const result = slots({ hours, now: at("2030-01-07T09:10"), rules: { leadTimeMin: 60 } });
    expect(times(result)[0]).toBe("2030-01-07T10:30");
  });

  it("offers nothing further ahead than max_advance_days", () => {
    const window = { start: at("2030-01-07T00:00"), end: at("2030-01-09T00:00") };
    const result = slots({
      hours: everyDay("09:00", "10:00"),
      window,
      now: at("2030-01-07T00:00"),
      rules: { maxAdvanceDays: 1 },
    });
    expect(times(result)).toEqual(["2030-01-07T09:00", "2030-01-07T09:30"]);
  });

  it("skips starts whose appointment overlaps a closure", () => {
    const closures = [{ start: at("2030-01-07T09:30"), end: at("2030-01-07T10:00") }];
    expect(times(slots({ closures }))).toEqual([
      "2030-01-07T09:00",
      "2030-01-07T10:00",
      "2030-01-07T10:30",
    ]);
  });
});

describe("freeSlots — existing appointments", () => {
  const hours = [{ dayOfWeek: MON, opensAt: "09:00", closesAt: "12:00" }];

  it("protects the buffer on both sides of an existing appointment", () => {
    // Existing 10:00 appointment of 30 min + 15 buffer holds 10:00–10:45.
    const result = times(
      slots({
        hours,
        window: { start: at("2030-01-07T09:00"), end: at("2030-01-07T11:30") },
        appointments: [booked(0, "2030-01-07T10:00", "2030-01-07T10:45")],
        rules: { slotIntervalMin: 15, bufferMin: 15 },
      }),
    );
    // 09:15 + 30 + 15 buffer ends exactly at 10:00: allowed. 09:30 would run into it.
    expect(result).toContain("2030-01-07T09:15");
    expect(result).not.toContain("2030-01-07T09:30");
    expect(result).not.toContain("2030-01-07T10:30");
    // The first start after the existing buffer ends.
    expect(result).toContain("2030-01-07T10:45");
  });

  it("gives out three resources at the same time, then the time is gone", () => {
    const twoTaken = [
      booked(0, "2030-01-07T10:00", "2030-01-07T10:30"),
      booked(1, "2030-01-07T10:00", "2030-01-07T10:30"),
    ];
    const tenOClock = (appointments: BusyAppointment[]) =>
      slots({ hours, appointments, rules: { capacity: 3 } }).find(
        (slot) => local(slot.start) === "2030-01-07T10:00",
      );

    expect(tenOClock(twoTaken)?.resourceIndex).toBe(2);
    expect(tenOClock([...twoTaken, booked(2, "2030-01-07T10:00", "2030-01-07T10:30")])).toBeUndefined();
  });

  it("takes the lowest free resource", () => {
    const result = slots({
      hours,
      appointments: [booked(0, "2030-01-07T09:00", "2030-01-07T12:00")],
      rules: { capacity: 3 },
    });
    expect(result[0]?.resourceIndex).toBe(1);
  });

  it("ignores an appointment on a resource above a reduced capacity", () => {
    const result = slots({
      hours,
      appointments: [booked(1, "2030-01-07T09:00", "2030-01-07T12:00")],
      rules: { capacity: 1 },
    });
    expect(result[0]).toEqual({ start: at("2030-01-07T09:00"), resourceIndex: 0 });
  });

  it("returns nothing when every resource is taken all day", () => {
    const result = slots({
      hours,
      appointments: [booked(0, "2030-01-07T09:00", "2030-01-07T12:00")],
    });
    expect(result).toEqual([]);
  });
});

describe("daysOfWeekInWindow", () => {
  it("includes the day before the window starts", () => {
    expect(
      daysOfWeekInWindow({ start: at("2030-01-05T00:00"), end: at("2030-01-05T03:00") }),
    ).toEqual([FRI, SAT]);
  });

  it("does not pull in the next day when the window ends at midnight", () => {
    expect(
      daysOfWeekInWindow({ start: at("2030-01-07T12:00"), end: at("2030-01-08T00:00") }),
    ).toEqual([0, MON]);
  });

  it("lists each weekday once for a window longer than a week", () => {
    expect(
      daysOfWeekInWindow({ start: at("2030-01-07T00:00"), end: at("2030-01-17T00:00") }),
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("spreadSlots", () => {
  it("takes the first, middle and last rather than three in a row", () => {
    expect(spreadSlots([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).toEqual([0, 5, 9]);
  });

  it("returns every slot when there are three or fewer", () => {
    expect(spreadSlots([0, 1])).toEqual([0, 1]);
  });
});

describe("freeChains — a pickup and a delivery", () => {
  const base = {
    now: at("2030-01-01T00:00"),
    // Pickups on Monday morning only.
    window: { start: at("2030-01-07T09:00"), end: at("2030-01-07T10:00") },
    hours: everyDay("09:00", "12:00"),
    closures: [],
    appointments: [],
    rules: { capacity: 1, slotIntervalMin: 30, bufferMin: 0, leadTimeMin: 0, maxAdvanceDays: 60 },
    steps: [{ durationMin: 15 }, { durationMin: 15, afterHours: 24 }],
  };
  const chains = (overrides: Partial<Parameters<typeof freeChains>[0]> = {}) =>
    freeChains({ ...base, ...overrides }).map((chain) => chain.slots.map((slot) => local(slot.start)));

  it("delivers at the earliest free time once the gap has passed", () => {
    expect(chains()).toEqual([
      ["2030-01-07T09:00", "2030-01-08T09:30"],
      ["2030-01-07T09:30", "2030-01-08T10:00"],
    ]);
  });

  it("counts the gap from the end of the pickup and its buffer", () => {
    expect(chains({ rules: { ...base.rules, bufferMin: 15 } })[0]).toEqual(["2030-01-07T09:00", "2030-01-08T09:30"]);
    expect(chains({ steps: [{ durationMin: 15 }, { durationMin: 15, afterHours: 0 }] })[0]).toEqual([
      "2030-01-07T09:00",
      "2030-01-07T09:30",
    ]);
  });

  it("moves the delivery past closed days and taken times", () => {
    const closedTuesday = everyDay("09:00", "12:00").filter((row) => row.dayOfWeek !== 2);
    expect(chains({ hours: closedTuesday })[0]).toEqual(["2030-01-07T09:00", "2030-01-09T09:00"]);
    expect(chains({ appointments: [booked(0, "2030-01-08T09:30", "2030-01-08T11:00")] })[0]).toEqual([
      "2030-01-07T09:00",
      "2030-01-08T11:00",
    ]);
  });

  it("doesn't offer a pickup with no delivery within a week of the gap", () => {
    const mondaysOnly = [{ dayOfWeek: MON, opensAt: "09:00", closesAt: "12:00" }];
    expect(chains({ hours: mondaysOnly })).toEqual([
      ["2030-01-07T09:00", "2030-01-14T09:00"],
      ["2030-01-07T09:30", "2030-01-14T09:00"],
    ]);
    const closedAfter = [{ start: at("2030-01-08T00:00"), end: at("2030-01-20T00:00") }];
    expect(chains({ closures: closedAfter })).toEqual([]);
  });

  it("is just the free slots for a single step", () => {
    expect(chains({ steps: [{ durationMin: 30 }] })).toEqual([["2030-01-07T09:00"], ["2030-01-07T09:30"]]);
  });
});

import { describe, expect, it } from "vitest";
import { expandRecurrence, zonedLocalToUtc } from "./recurrence";

describe("scheduling recurrence", () => {
  it("expands weekly rules with stable local-date keys", () => {
    const occurrences = expandRecurrence({
      id: "rule-1",
      frequency: "weekly",
      intervalCount: 1,
      byWeekday: [1, 3],
      byMonthDay: null,
      localTime: "09:15",
      timeZone: "Asia/Kolkata",
      startsOn: "2026-07-13",
      endsOn: null,
      countLimit: null,
    }, "2026-07-13", "2026-07-22");
    expect(occurrences.map((item) => item.localDate)).toEqual([
      "2026-07-13", "2026-07-15", "2026-07-20", "2026-07-22",
    ]);
    expect(occurrences[0]).toMatchObject({
      occurrenceKey: "rule-1:2026-07-13T09:15@Asia/Kolkata",
      scheduledFor: "2026-07-13T03:45:00.000Z",
      dstAdjustment: "exact",
    });
  });

  it("skips nonexistent month days without drifting", () => {
    const occurrences = expandRecurrence({
      id: "month-end",
      frequency: "monthly",
      intervalCount: 1,
      byWeekday: [],
      byMonthDay: 31,
      localTime: "12:00",
      timeZone: "UTC",
      startsOn: "2026-01-31",
      endsOn: "2026-05-31",
      countLimit: null,
    }, "2026-01-01", "2026-05-31");
    expect(occurrences.map((item) => item.localDate)).toEqual([
      "2026-01-31", "2026-03-31", "2026-05-31",
    ]);
  });

  it("moves a DST-gap wall time to the first valid minute", () => {
    const result = zonedLocalToUtc("2026-03-08", "02:30", "America/New_York");
    expect(result.instant.toISOString()).toBe("2026-03-08T07:00:00.000Z");
    expect(result.dstAdjustment).toBe("gap_forward");
  });

  it("chooses the earlier instant during a DST overlap", () => {
    const result = zonedLocalToUtc("2026-11-01", "01:30", "America/New_York");
    expect(result.instant.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(result.dstAdjustment).toBe("overlap_earlier");
  });

  it("respects an occurrence count across a filtered window", () => {
    const occurrences = expandRecurrence({
      id: "limited",
      frequency: "daily",
      intervalCount: 1,
      byWeekday: [],
      byMonthDay: null,
      localTime: "08:00",
      timeZone: "UTC",
      startsOn: "2026-01-01",
      endsOn: null,
      countLimit: 3,
    }, "2026-01-02", "2026-01-10");
    expect(occurrences.map((item) => item.localDate)).toEqual(["2026-01-02", "2026-01-03"]);
  });
});

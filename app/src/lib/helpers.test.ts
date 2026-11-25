import { describe, expect, it } from "vitest";
import { currencyChoice, normalizeStake, stakeError } from "./stake";
import { fitWithin, planDownscale, PROOF_TARGET_BYTES } from "./image";
import {
  checkScheduleDraft,
  countOccurrences,
  formatClockText,
  formatDays,
  formatDuration,
  formatScheduleSummary,
  formatWindow,
  occurrenceKind,
  spanDays,
  zonedWallTimeToUtc,
  type ScheduleDraft,
} from "./schedule";
import { describeLedgerEntry, signedPoints } from "./ledger";
import { formatDeadline, formatTimeOfDay } from "./bets";
import type { PointsLedgerEntry } from "./relayer";

describe("stake validation", () => {
  it("requires whole points of at least 1", () => {
    expect(stakeError("500", "PTS")).toBeNull();
    expect(stakeError("1", "PTS")).toBeNull();
    expect(stakeError("0", "PTS")).toMatch(/whole numbers/);
    expect(stakeError("2.5", "PTS")).toMatch(/whole numbers/);
    expect(stakeError("-3", "PTS")).toMatch(/whole numbers/);
    expect(stakeError("", "PTS")).toMatch(/whole numbers/);
    expect(stakeError("1000000001", "PTS")).toMatch(/or fewer/);
  });

  it("allows decimal SOL above zero", () => {
    expect(stakeError("0.25", "SOL")).toBeNull();
    expect(stakeError("0", "SOL")).toMatch(/above 0/);
    expect(stakeError("abc", "SOL")).toMatch(/above 0/);
  });

  it("normalises leading zeros on points", () => {
    expect(normalizeStake(" 0500 ", "PTS")).toBe("500");
    expect(normalizeStake("0.50", "SOL")).toBe("0.50");
  });

  it("picks currency options from the server config", () => {
    expect(currencyChoice({ allowed: ["PTS", "SOL"], default: "PTS" })).toEqual({ options: ["PTS", "SOL"], initial: "PTS" });
    expect(currencyChoice({ allowed: ["SOL"], default: "SOL" })).toEqual({ options: ["SOL"], initial: "SOL" });
    expect(currencyChoice({ allowed: ["PTS", "SOL"], default: "SOL" }).initial).toBe("SOL");
    expect(currencyChoice(null)).toEqual({ options: ["SOL"], initial: "SOL" });
  });
});

describe("image downscale sizing", () => {
  it("keeps small images as they are", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
  });

  it("caps the long edge at 1600 and keeps the aspect ratio", () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1200, height: 1600 });
    expect(fitWithin(10000, 10)).toEqual({ width: 1600, height: 2 });
  });

  it("handles bad dimensions", () => {
    expect(fitWithin(0, 100)).toEqual({ width: 0, height: 0 });
  });

  it("re-encodes when resized, heavy, or an unusual type", () => {
    expect(planDownscale({ width: 800, height: 600, bytes: 200_000, type: "image/jpeg" }).reencode).toBe(false);
    expect(planDownscale({ width: 4000, height: 3000, bytes: 200_000, type: "image/jpeg" })).toEqual({ width: 1600, height: 1200, reencode: true });
    expect(planDownscale({ width: 800, height: 600, bytes: PROOF_TARGET_BYTES + 1, type: "image/png" }).reencode).toBe(true);
    expect(planDownscale({ width: 800, height: 600, bytes: 1000, type: "image/heic" }).reencode).toBe(true);
  });
});

describe("schedule text", () => {
  it("names day sets", () => {
    expect(formatDays([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(formatDays([0, 1, 2, 3, 4, 5, 6])).toBe("Every day");
    expect(formatDays([1, 2, 3, 4, 5])).toBe("Weekdays");
    expect(formatDays([6, 0])).toBe("Weekends");
    expect(formatDays([2])).toBe("Tuesdays");
    expect(formatDays([0, 1])).toBe("Mon, Sun");
  });

  it("names durations", () => {
    expect(formatDuration(21)).toBe("3 weeks");
    expect(formatDuration(7)).toBe("1 week");
    expect(formatDuration(10)).toBe("10 days");
    expect(formatDuration(1)).toBe("1 day");
  });

  it("summarises a schedule", () => {
    expect(formatScheduleSummary({ daysOfWeek: [1, 3, 5], startDate: "2026-12-07", endDate: "2026-12-27" }))
      .toBe("Mon, Wed, Fri for 3 weeks");
  });

  it("formats clock times and windows", () => {
    expect(formatClockText("06:00")).toBe("6 AM");
    expect(formatClockText("18:30")).toBe("6:30 PM");
    expect(formatClockText("12:00")).toBe("noon");
    expect(formatClockText("24:00")).toBe("midnight");
    expect(formatWindow({})).toBeNull();
    expect(formatWindow({ windowStart: "06:00", windowEnd: "08:00" })).toBe("between 6 AM and 8 AM");
  });

  it("counts occurrences and spans", () => {
    // Dec 7 2026 is a Monday.
    expect(countOccurrences([1, 3, 5], "2026-12-07", "2026-12-27")).toBe(9);
    expect(countOccurrences([0, 1, 2, 3, 4, 5, 6], "2026-12-01", "2026-12-01")).toBe(1);
    expect(spanDays("2026-12-07", "2026-12-27")).toBe(21);
    expect(spanDays("2026-12-07", "2026-12-01")).toBe(0);
  });

  it("converts wall time in a timezone to UTC", () => {
    // New York is UTC−5 in December.
    expect(zonedWallTimeToUtc(2026, 12, 7, 6 * 60, "America/New_York")).toBe(Date.UTC(2026, 11, 7, 11, 0));
    expect(zonedWallTimeToUtc(2026, 12, 7, 0, "UTC")).toBe(Date.UTC(2026, 11, 7));
  });

  it("maps occurrence states to strip kinds", () => {
    expect(occurrenceKind("approved")).toBe("done");
    expect(occurrenceKind("approved-by-default")).toBe("done");
    expect(occurrenceKind("submitted")).toBe("review");
    expect(occurrenceKind("open")).toBe("today");
    expect(occurrenceKind("rejected")).toBe("missed");
    expect(occurrenceKind("upcoming")).toBe("upcoming");
  });
});

describe("schedule draft checks", () => {
  const now = Date.UTC(2026, 11, 7, 15, 0); // Mon Dec 7 2026, 10 AM in New York
  const draft = (patch: Partial<ScheduleDraft> = {}): ScheduleDraft => ({
    daysOfWeek: [1, 3, 5],
    startDate: "2026-12-07",
    endDate: "2026-12-27",
    timezone: "America/New_York",
    window: null,
    required: null,
    ...patch,
  });

  it("accepts a valid schedule and counts M", () => {
    const check = checkScheduleDraft(draft(), now);
    expect(check.errors).toEqual({});
    expect(check.total).toBe(9);
    expect(check.required).toBe(9);
  });

  it("mirrors the relayer limits", () => {
    expect(checkScheduleDraft(draft({ endDate: "2027-03-20" }), now).errors.endDate).toMatch(/90 days/);
    expect(checkScheduleDraft(draft({ startDate: "2027-02-10", endDate: "2027-02-20" }), now).errors.startDate).toMatch(/60 days/);
    expect(checkScheduleDraft(draft({ endDate: "2026-12-06" }), now).errors.endDate).toMatch(/on or after/);
    expect(checkScheduleDraft(draft({ daysOfWeek: [] }), now).errors.days).toMatch(/at least one/);
    expect(checkScheduleDraft(draft({ daysOfWeek: [2], startDate: "2026-12-07", endDate: "2026-12-07" }), now).errors.days)
      .toMatch(/None of those days/);
    expect(checkScheduleDraft(draft({ required: 10 }), now).errors.required).toBe("Pick between 1 and 9.");
    expect(checkScheduleDraft(draft({ required: 7 }), now).required).toBe(7);
  });

  it("rejects a window that's already over today", () => {
    const check = checkScheduleDraft(draft({ window: { start: "06:00", end: "08:00" } }), now);
    expect(check.errors.startDate).toMatch(/already closed/);
    expect(checkScheduleDraft(draft({ window: { start: "06:00", end: "20:00" } }), now).errors).toEqual({});
    expect(checkScheduleDraft(draft({ window: { start: "09:00", end: "08:00" } }), now).errors.window).toMatch(/end after/);
  });
});

describe("deadline text", () => {
  const now = new Date(2026, 10, 25, 11, 30).getTime(); // Wed Nov 25, local time

  it("spells out midnight as the end of the day before", () => {
    expect(formatDeadline(new Date(2026, 10, 26, 0, 0).getTime(), now)).toBe("end of today");
    expect(formatDeadline(new Date(2026, 10, 27, 0, 0).getTime(), now)).toBe("end of tomorrow");
    expect(formatTimeOfDay(new Date(2026, 10, 26, 0, 0).getTime())).toBe("midnight");
  });

  it("keeps ordinary times", () => {
    expect(formatDeadline(new Date(2026, 10, 25, 17, 0).getTime(), now)).toMatch(/^today /);
  });
});

describe("points ledger text", () => {
  const entry = (patch: Partial<PointsLedgerEntry>): PointsLedgerEntry => ({
    key: "k", kind: "hold", delta: -250, amount: 250, reason: "stake for bet x", betId: "x", createdAt: 0, ...patch,
  });

  it("signs amounts", () => {
    expect(signedPoints(500)).toBe("+500");
    expect(signedPoints(-1250)).toBe("−1,250");
  });

  it("describes entries in plain words", () => {
    expect(describeLedgerEntry(entry({ kind: "payout", delta: 500, amount: 500 }), { groupName: "Gym rats" }))
      .toMatchObject({ title: "Won Gym rats bet", amount: "+500" });
    expect(describeLedgerEntry(entry({}))).toMatchObject({ title: "Stake held", amount: "−250" });
    expect(describeLedgerEntry(entry({ kind: "grant", delta: 1000, amount: 1000, betId: null })).title).toBe("Welcome points");
    expect(describeLedgerEntry(entry({ kind: "topup", delta: 60, amount: 60 })).title).toBe("Daily top-up");
    expect(describeLedgerEntry(entry({ kind: "burn", delta: 0 })).amount).toBe("");
  });
});

// The TZ that date-fns sees is pinned in jest.config.js before workers start;
// setting it here has no effect and only documents the assumption.
process.env.TZ = "UTC";

import {
    resolveGenerationWeekStart,
    resolveViewWeek,
    weekStartKey,
} from "../discoveryWeek";

describe("resolveGenerationWeekStart -- boundary roll-forward", () => {
    // On the week's last day startOfWeek returns the ending week; the helper
    // must roll forward.
    it("rolls forward to the UPCOMING Monday when run on the week's last day (Sunday 20:00, Monday-start)", () => {
        const sundayEvening = new Date("2026-05-24T20:00:00.000Z");
        const result = resolveGenerationWeekStart(sundayEvening, 1);
        // Bare startOfWeek would yield 2026-05-18, the week that is ending.
        expect(result.toISOString().slice(0, 10)).toBe("2026-05-25");
    });

    it("rolls forward at the very last instant of the week (Sunday 23:59:59.999) -- isSameDay edge", () => {
        // Boundary: the final millisecond is still the same calendar day as
        // endOfWeek (which is 23:59:59.999). A `now >= endOfWeek` comparison
        // using strict inequality, or an isAfter check, would miss this and
        // tag the ending week. Must still roll forward.
        const lastInstant = new Date("2026-05-24T23:59:59.999Z");
        const result = resolveGenerationWeekStart(lastInstant, 1);
        expect(result.toISOString().slice(0, 10)).toBe("2026-05-25");
    });

    it("does NOT roll forward at the first instant of the week (Monday 00:00:00.000) -- the off-by-one in the other direction", () => {
        // Inverse boundary: Monday midnight is the START of the week, never the
        // end. A buggy `isSameDay(now, startOfWeek)`-based or always-add-1
        // implementation would push this to 2026-06-01. Must stay on 2026-05-25.
        const firstInstant = new Date("2026-05-25T00:00:00.000Z");
        const result = resolveGenerationWeekStart(firstInstant, 1);
        expect(result.toISOString().slice(0, 10)).toBe("2026-05-25");
    });

    it("honors a configurable week-start day -- Saturday under Sunday-start (weekStartsOn=0) rolls forward", () => {
        // The weekStartsOn seam Phase 2 depends on. With Sunday-start, Saturday
        // is the last day, so it must roll forward to the next Sunday. A
        // hard-coded `{weekStartsOn: 1}` would compute the Monday-based week and
        // return 2026-05-25 (Monday) instead of 2026-05-31 (Sunday).
        const saturday = new Date("2026-05-30T20:00:00.000Z");
        const result = resolveGenerationWeekStart(saturday, 0);
        expect(result.toISOString().slice(0, 10)).toBe("2026-05-31");
    });

    it("does not roll forward mid-week (Wednesday, Monday-start) -- tags the current week", () => {
        const wednesday = new Date("2026-05-27T12:00:00.000Z");
        const result = resolveGenerationWeekStart(wednesday, 1);
        expect(result.toISOString().slice(0, 10)).toBe("2026-05-25");
    });

    it("defaults to Monday-start (weekStartsOn omitted) -- proves the default arg, not an undefined->NaN week", () => {
        // If the default parameter is missing, date-fns receives
        // {weekStartsOn: undefined} -> defaults to Sunday-start, shifting the
        // boundary. Calling with no second arg must behave exactly like `, 1`.
        const wednesday = new Date("2026-05-27T12:00:00.000Z");
        const result = resolveGenerationWeekStart(wednesday);
        expect(result.toISOString().slice(0, 10)).toBe("2026-05-25");
    });

    // The week start is exactly midnight UTC, not the run's time of day, since
    // it is stored and compared against midnight values.
    it("returns the week-start normalized to 00:00:00.000 UTC -- not the run's time-of-day (mid-week branch)", () => {
        const wednesdayNoon = new Date("2026-05-27T12:00:00.000Z");
        const result = resolveGenerationWeekStart(wednesdayNoon, 1);
        expect(result.toISOString()).toBe("2026-05-25T00:00:00.000Z");
    });

    it("returns the week-start normalized to 00:00:00.000 UTC after rolling forward (Sunday-evening branch)", () => {
        // The roll-forward path must ALSO land on midnight. addWeeks(startOfWeek)
        // gives midnight; addWeeks(now) or a time-preserving roll would carry the
        // 20:00 forward and produce "2026-05-25T20:00:00.000Z", passing the slice
        // tests above but storing a corrupt weekStart.
        const sundayEvening = new Date("2026-05-24T20:00:00.000Z");
        const result = resolveGenerationWeekStart(sundayEvening, 1);
        expect(result.toISOString()).toBe("2026-05-25T00:00:00.000Z");
    });
});

describe("resolveViewWeek -- fallback, staleness, and the null path", () => {
    const calendar = new Date("2026-05-25T00:00:00.000Z");

    it("returns the calendar week and stale=false when there is NO batch (the null path)", () => {
        // The catch-all for a brand-new install / no completed batch. A naive
        // `latestBatchWeekStart!` or unguarded `.weekStart` would throw on null;
        // returning {stale:true} here would mislabel a fresh empty week.
        const r = resolveViewWeek(calendar, null);
        expect(r.weekStart).toEqual(calendar);
        expect(r.stale).toBe(false);
    });

    it("serves a weeks-old completed batch UNCONDITIONALLY, flagged stale (cleanup never deletes the latest week)", () => {
        // The production data-loss scenario: the only surviving batch is 3 weeks
        // back. rev-2's discarded "±1 week cliff" would have BLANKED this out.
        // The discriminator is the pair: weekStart must equal the OLD date (not
        // the calendar week) AND stale must be true.
        const old = new Date("2026-05-04T00:00:00.000Z"); // 3 calendar weeks back
        const r = resolveViewWeek(calendar, old);
        expect(r.weekStart).toEqual(old);
        expect(r.stale).toBe(true);
    });

    it("flags stale=true for a batch exactly one week old (immediate-prior boundary)", () => {
        // Boundary between fresh and stale: a batch from last week is strictly
        // before the calendar week, so it is stale. An `isBefore`-with-tolerance
        // or `<=`-vs-`<` confusion would mis-flag this edge.
        const lastWeek = new Date("2026-05-18T00:00:00.000Z");
        const r = resolveViewWeek(calendar, lastWeek);
        expect(r.weekStart).toEqual(lastWeek);
        expect(r.stale).toBe(true);
    });

    it("serves a FUTURE-dated batch (generated early for next week) as stale=false", () => {
        // Generation tags the upcoming week, so on Sunday the latest batch can
        // be week-ahead of the calendar. isBefore(future, calendar) is false ->
        // not stale. A symmetric `!isSameDay` staleness test would wrongly flag
        // this as stale; an `isAfter`-throws path would mis-handle it.
        const future = new Date("2026-06-01T00:00:00.000Z");
        const r = resolveViewWeek(calendar, future);
        expect(r.weekStart).toEqual(future);
        expect(r.stale).toBe(false);
    });

    // A batch from later in the same week (Wed vs a Monday start) is fresh and
    // served as is.
    it("treats a batch from later in the SAME calendar week (Wed vs Mon start) as fresh, serving the batch date", () => {
        const wednesdaySameWeek = new Date("2026-05-27T00:00:00.000Z");
        const r = resolveViewWeek(calendar, wednesdaySameWeek);
        expect(r.weekStart).toEqual(wednesdaySameWeek);
        expect(r.stale).toBe(false);
    });

    // HAPPY PATH (last): batch matches the current calendar week.
    it("matches the calendar week exactly -> stale=false (happy path)", () => {
        const r = resolveViewWeek(calendar, new Date("2026-05-25T00:00:00.000Z"));
        expect(r.weekStart).toEqual(calendar);
        expect(r.stale).toBe(false);
    });
});

describe("weekStartKey -- stable jobId key", () => {
    it("truncates the time component to a YYYY-MM-DD key (dedup stability)", () => {
        // The BullMQ jobId must be stable across the day; a non-truncated
        // toISOString() would embed the time and break dedup. This proves the
        // .slice(0,10), not just any string.
        expect(weekStartKey(new Date("2026-05-25T05:00:00.000Z"))).toBe("2026-05-25");
    });

    it("does not roll the date backward for a late-evening UTC instant (no local-TZ leak)", () => {
        // A key built from local-string formatting (toLocaleDateString / getDate)
        // on a non-UTC host would shift 23:30 UTC to the previous day. Using the
        // UTC ISO slice keeps it on 2026-05-25.
        expect(weekStartKey(new Date("2026-05-25T23:30:00.000Z"))).toBe("2026-05-25");
    });

    // The job key is built from resolveGenerationWeekStart's output, so a
    // Sunday-evening run keys the upcoming week.
    it("a Sunday-evening generation run produces the UPCOMING week's key (helper composition)", () => {
        const sundayEvening = new Date("2026-05-24T20:00:00.000Z");
        const tagged = resolveGenerationWeekStart(sundayEvening, 1);
        expect(weekStartKey(tagged)).toBe("2026-05-25");
    });

    it("two runs on different days of the same week produce the SAME key (dedup stability across the week)", () => {
        // The whole point of keying on the week is that Mon and Wed runs collide
        // in BullMQ. resolveGenerationWeekStart(Mon) and (Wed) must both key to
        // 2026-05-25; if either returned a non-midnight or day-shifted Date the
        // keys would diverge and the dedup would silently fail.
        const monday = new Date("2026-05-25T05:00:00.000Z");
        const wednesday = new Date("2026-05-27T12:00:00.000Z");
        const kMon = weekStartKey(resolveGenerationWeekStart(monday, 1));
        const kWed = weekStartKey(resolveGenerationWeekStart(wednesday, 1));
        expect(kMon).toBe("2026-05-25");
        expect(kWed).toBe("2026-05-25");
        expect(kMon).toBe(kWed);
    });
});

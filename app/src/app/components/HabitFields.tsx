/** "Make it a habit": the recurring check-in schedule inside New bet. */
import { useMemo, useState } from "react";
import { Minus, Plus } from "lucide-react";
import type { BetVoteChoice } from "../../lib/relayer";
import {
  addDaysToKey,
  allTimeZones,
  deviceTimeZone,
  timeZoneLabel,
  todayKey,
  WEEKDAY_LONG,
  WEEKDAY_ORDER,
  WEEKDAY_SHORT,
  type ScheduleDraft,
  type ScheduleErrors,
} from "../../lib/schedule";
import { cn } from "../../lib/cn";
import { Field, Segmented, TextInput, buttonClass, useFieldId } from "./primitives";

export interface HabitState {
  draft: ScheduleDraft;
  doer: BetVoteChoice;
}

export function initialHabit(): HabitState {
  const timezone = deviceTimeZone();
  const start = todayKey(timezone);
  return {
    draft: {
      daysOfWeek: [1, 3, 5],
      startDate: start,
      endDate: addDaysToKey(start, 20),
      timezone,
      window: null,
      required: null,
    },
    doer: "challenger",
  };
}

export function HabitFields({
  value,
  onChange,
  errors,
  total,
  acceptorLabel,
  show,
}: {
  value: HabitState;
  onChange: (next: HabitState) => void;
  errors: ScheduleErrors;
  /** M, computed live from the days and dates. */
  total: number;
  /** "Whoever accepts" or the named opponent. */
  acceptorLabel: string;
  /** Errors only after the first post attempt. */
  show: boolean;
}) {
  const { draft } = value;
  const ids = {
    start: useFieldId("habit-start"),
    end: useFieldId("habit-end"),
    from: useFieldId("habit-from"),
    to: useFieldId("habit-to"),
    tz: useFieldId("habit-tz"),
  };
  const [changingTz, setChangingTz] = useState(false);
  const zones = useMemo(() => (changingTz ? allTimeZones() : []), [changingTz]);
  const set = (patch: Partial<ScheduleDraft>) => onChange({ ...value, draft: { ...draft, ...patch } });
  const required = draft.required ?? total;
  const err = (key: keyof ScheduleErrors) => (show ? errors[key] : undefined);
  const today = todayKey(draft.timezone);

  return (
    <div className="space-y-5">
      <Field label="On these days" error={err("days")}>
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days of the week">
          {WEEKDAY_ORDER.map((day) => {
            const on = draft.daysOfWeek.includes(day);
            return (
              <button
                key={day}
                type="button"
                aria-pressed={on}
                aria-label={WEEKDAY_LONG[day]}
                onClick={() => set({
                  daysOfWeek: on ? draft.daysOfWeek.filter((d) => d !== day) : [...draft.daysOfWeek, day],
                  required: null,
                })}
                className={cn(
                  "min-h-11 min-w-12 rounded-full border px-3 text-label font-semibold transition-colors md:min-h-10",
                  on ? "border-ink bg-ink text-paper" : "border-rule text-ink hover:bg-hover",
                )}
              >
                {WEEKDAY_SHORT[day]}
              </button>
            );
          })}
        </div>
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Starts" htmlFor={ids.start} error={err("startDate")}>
          <TextInput
            id={ids.start}
            type="date"
            value={draft.startDate}
            min={today}
            max={addDaysToKey(today, 60)}
            onChange={(event) => set({ startDate: event.target.value, required: null })}
            aria-invalid={Boolean(err("startDate"))}
          />
        </Field>
        <Field label="Ends" htmlFor={ids.end} error={err("endDate")}>
          <TextInput
            id={ids.end}
            type="date"
            value={draft.endDate}
            min={draft.startDate || today}
            max={draft.startDate ? addDaysToKey(draft.startDate, 89) : undefined}
            onChange={(event) => set({ endDate: event.target.value, required: null })}
            aria-invalid={Boolean(err("endDate"))}
          />
        </Field>
      </div>

      <Field label="Check-in time" error={err("window")} hint={draft.window ? "Check-ins only count inside this window." : "Any time that day counts."}>
        <Segmented
          label="Check-in time"
          value={draft.window ? "window" : "day"}
          onChange={(next) => set({ window: next === "window" ? { start: "06:00", end: "09:00" } : null })}
          size="sm"
          options={[
            { value: "day", label: "Any time that day" },
            { value: "window", label: "Set a window" },
          ]}
        />
        {draft.window && (
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label htmlFor={ids.from} className="sr-only">From</label>
            <TextInput
              id={ids.from}
              type="time"
              value={draft.window.start}
              onChange={(event) => set({ window: { ...draft.window!, start: event.target.value } })}
              className="w-36"
            />
            <span className="text-label text-ink-soft">to</span>
            <label htmlFor={ids.to} className="sr-only">Until</label>
            <TextInput
              id={ids.to}
              type="time"
              value={draft.window.end === "24:00" ? "23:59" : draft.window.end}
              onChange={(event) => set({ window: { ...draft.window!, end: event.target.value } })}
              className="w-36"
            />
          </div>
        )}
      </Field>

      <Field label="Timezone" htmlFor={changingTz ? ids.tz : undefined} error={err("timezone")}>
        {changingTz ? (
          <select
            id={ids.tz}
            value={draft.timezone}
            onChange={(event) => set({ timezone: event.target.value })}
            className="block min-h-12 w-full max-w-md rounded-xl border border-rule bg-paper px-3 text-body"
          >
            {!zones.includes(draft.timezone) && <option value={draft.timezone}>{timeZoneLabel(draft.timezone)}</option>}
            {zones.map((zone) => (
              <option key={zone} value={zone}>{zone.replace(/_/g, " ").replace(/\//g, " / ")}</option>
            ))}
          </select>
        ) : (
          <p className="text-label">
            {timeZoneLabel(draft.timezone)}
            <button
              type="button"
              onClick={() => setChangingTz(true)}
              className="ml-2 min-h-11 rounded-md px-1 font-semibold underline underline-offset-4 md:min-h-0"
            >
              Change
            </button>
          </p>
        )}
      </Field>

      <Field
        label="Check-ins needed"
        error={err("required")}
        hint={total > 0
          ? required === total ? `Every one of the ${total} days.` : `Can miss ${total - required} of ${total} days.`
          : "Pick days and dates to see how many check-ins there are."}
      >
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={buttonClass("secondary", "icon")}
            onClick={() => set({ required: Math.max(1, required - 1) })}
            disabled={required <= 1 || total === 0}
            aria-label="Fewer check-ins needed"
          >
            <Minus size={18} aria-hidden />
          </button>
          <output className="min-w-24 text-center text-label" aria-live="polite">
            <span className="text-[22px] font-extrabold wdth-condensed tabular-nums">{total === 0 ? 0 : required}</span>
            <span className="text-ink-soft"> of {total}</span>
          </output>
          <button
            type="button"
            className={buttonClass("secondary", "icon")}
            onClick={() => set({ required: Math.min(total, required + 1) })}
            disabled={required >= total}
            aria-label="More check-ins needed"
          >
            <Plus size={18} aria-hidden />
          </button>
        </div>
      </Field>

      <Field label="Who's doing it" hint="They check in with proof each day. Witnesses approve or reject each check-in.">
        <Segmented
          label="Who's doing it"
          value={value.doer}
          onChange={(doer) => onChange({ ...value, doer })}
          size="sm"
          options={[
            { value: "challenger", label: "Me" },
            { value: "acceptor", label: acceptorLabel },
          ]}
        />
      </Field>
    </div>
  );
}

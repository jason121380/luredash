import { cn } from "@/lib/cn";
import {
  DP_PRESETS,
  type DateConfig,
  type DatePreset,
  fmtDate,
  resolveRange,
  toShortLabel,
} from "@/lib/datePicker";
import * as Popover from "@radix-ui/react-popover";
import { useEffect, useMemo, useState } from "react";

/**
 * DatePicker — trigger button + popover with 7 presets on the left and
 * a month calendar on the right. Ports the legacy `class DatePicker`
 * from the original design lines 1306–1533.
 *
 * Visual contract:
 * - Trigger: 36px height, 1.5px border, orange calendar icon, NO arrow
 *   (the legacy `.dp-arrow` span is intentionally omitted per style.md).
 * - Popover: 150px preset column + 268px min calendar.
 * - Custom range: two-click flow, first click sets `from`, second sets
 *   `to`; clicks auto-order if user picks end before start.
 */

export interface DatePickerProps {
  value: DateConfig;
  onChange: (config: DateConfig) => void;
  defaultPreset?: DatePreset;
  /** Restrict the preset list (and hide the custom calendar pane).
   * Used by 安全監控 to cap range at last_30d / 上個月 so the user
   * can't pick dates older than what 立即掃描 actually fetches
   * (last_90d). When set, the calendar / custom range UI is removed
   * entirely — the picker becomes a flat preset chooser. */
  allowedPresets?: ReadonlyArray<Exclude<DatePreset, "custom">>;
}

export function DatePicker({ value, onChange, allowedPresets }: DatePickerProps) {
  const presets = useMemo(
    () =>
      allowedPresets
        ? DP_PRESETS.filter((p) => allowedPresets.includes(p.value))
        : DP_PRESETS,
    [allowedPresets],
  );
  const hideCalendar = !!allowedPresets;
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState<"from" | "to">("from");
  const [customFrom, setCustomFrom] = useState<string | null>(
    value.preset === "custom" ? value.from : null,
  );
  const [customTo, setCustomTo] = useState<string | null>(
    value.preset === "custom" ? value.to : null,
  );
  const [viewDate, setViewDate] = useState<Date>(() => {
    const d = new Date();
    d.setDate(1);
    return d;
  });

  // When opening: align the calendar to the current resolved range
  // so the user sees which dates are currently selected without
  // extra clicks. Matches the legacy DatePicker.open() behavior.
  useEffect(() => {
    if (open) {
      const range = resolveRange(value);
      if (range.start) {
        const d = new Date(`${range.start}T00:00:00`);
        setViewDate(new Date(d.getFullYear(), d.getMonth(), 1));
      }
      // Sync the draft custom range to whatever is currently resolved
      // so the calendar highlights the active selection on every open.
      if (value.preset === "custom") {
        setCustomFrom(value.from);
        setCustomTo(value.to);
      } else {
        setCustomFrom(null);
        setCustomTo(null);
      }
      setPicking("from");
    }
  }, [open, value]);

  const range = useMemo(() => resolveRange(value), [value]);
  // 觸發按鈕顯示緊湊版 (M/D~M/D),避免在窄畫面把帳戶選擇器擠出視野
  const label = useMemo(() => toShortLabel(value), [value]);

  const selectPreset = (preset: Exclude<DatePreset, "custom">) => {
    setCustomFrom(null);
    setCustomTo(null);
    setPicking("from");
    setOpen(false);
    onChange({ preset, from: null, to: null });
  };

  // Direct calendar click flow (no "自訂" gate):
  //   click 1 → sets `from`, switches to picking=to
  //   click 2 → sets `to` (auto-orders if before `from`), auto-applies
  //             and closes the popover
  const selectDay = (dateStr: string) => {
    if (picking === "from") {
      setCustomFrom(dateStr);
      setCustomTo(null);
      setPicking("to");
      return;
    }
    let from = customFrom;
    let to = dateStr;
    if (from && dateStr < from) {
      to = from;
      from = dateStr;
    }
    setCustomFrom(from);
    setCustomTo(to);
    setPicking("from");
    if (from && to) {
      setOpen(false);
      onChange({ preset: "custom", from, to });
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            "flex h-10 select-none items-center gap-2 whitespace-nowrap rounded-xl border-[1.5px] px-3.5 leading-none md:h-9",
            "text-[13px] font-medium text-ink font-sans",
            "transition-all duration-150 cursor-pointer active:scale-95",
            open
              ? "border-orange ring-[3px] ring-orange/10 bg-white"
              : "border-border bg-white hover:border-orange-border hover:bg-orange-bg",
          )}
        >
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="shrink-0 text-orange"
            role="img"
            aria-label="calendar"
          >
            <title>calendar</title>
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          <span className="inline-flex items-center">{label}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            "z-[999] flex max-w-[calc(100vw-24px)] flex-col overflow-hidden rounded-2xl border-[1.5px] border-border bg-white md:flex-row",
            "shadow-[0_12px_48px_rgba(0,0,0,0.12)] animate-fade-in",
          )}
        >
          {/* Presets — horizontal scrolling pills on mobile, vertical column on desktop */}
          <div className="flex shrink-0 gap-1.5 overflow-x-auto border-b border-border p-2 md:w-[150px] md:flex-col md:gap-0 md:overflow-visible md:border-r md:border-b-0">
            {presets.map((preset) => {
              const active = value.preset === preset.value;
              return (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => selectPreset(preset.value)}
                  className={cn(
                    "flex shrink-0 select-none items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-[13px] md:w-full",
                    "cursor-pointer transition-colors duration-100",
                    active
                      ? "bg-orange-bg font-semibold text-orange"
                      : "text-gray-500 hover:bg-orange-bg hover:text-orange",
                  )}
                >
                  <span
                    className={cn(
                      "h-1.5 w-1.5 shrink-0 rounded-full border-[1.5px]",
                      active ? "border-orange bg-orange" : "border-gray-300",
                    )}
                  />
                  {preset.label}
                </button>
              );
            })}
          </div>

          {!hideCalendar && (
            <div className="relative flex flex-col">
              {/* Calendar — always interactive, no "自訂" gate. First
                  click sets from, second click sets to and auto-applies. */}
              <Calendar
                viewDate={viewDate}
                onPrev={() =>
                  setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() - 1, 1))
                }
                onNext={() =>
                  setViewDate(new Date(viewDate.getFullYear(), viewDate.getMonth() + 1, 1))
                }
                onSelectDay={selectDay}
                from={customFrom ?? range.start}
                to={customTo ?? range.end}
                picking={picking}
              />

              {/* Footer — always shows the current range (or the draft
                  during a custom pick). No apply button: second calendar
                  click auto-applies. */}
              <div className="px-4 pb-3">
                <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5 text-xs text-gray-500">
                  <span className="rounded-md bg-orange-bg px-2.5 py-1 font-medium text-orange">
                    {customFrom ?? range.start ?? "開始日期"}
                  </span>
                  <span className="text-gray-300">→</span>
                  <span className="rounded-md bg-orange-bg px-2.5 py-1 font-medium text-orange">
                    {customTo ?? range.end ?? "結束日期"}
                  </span>
                </div>
              </div>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

interface CalendarProps {
  viewDate: Date;
  onPrev: () => void;
  onNext: () => void;
  onSelectDay: (dateStr: string) => void;
  from: string | null;
  to: string | null;
  picking: "from" | "to";
}

function Calendar({ viewDate, onPrev, onNext, onSelectDay, from, to }: CalendarProps) {
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const today = fmtDate(new Date());
  const monthNames = [
    "1月",
    "2月",
    "3月",
    "4月",
    "5月",
    "6月",
    "7月",
    "8月",
    "9月",
    "10月",
    "11月",
    "12月",
  ];

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevMonthDays = new Date(year, month, 0).getDate();

  // Each cell gets a stable, unique key. For in-month cells we use the
  // ISO date string. For leading/trailing placeholders we prefix with
  // `pre-` / `post-` so they're distinct from real dates AND stable
  // across re-renders without relying on array index.
  const cells: Array<{ key: string; date: string | null; day: number; inMonth: boolean }> = [];
  for (let i = firstDay - 1; i >= 0; i--) {
    cells.push({
      key: `pre-${prevMonthDays - i}`,
      date: null,
      day: prevMonthDays - i,
      inMonth: false,
    });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    cells.push({ key: ds, date: ds, day: d, inMonth: true });
  }
  const remainder = (7 - (cells.length % 7)) % 7;
  for (let i = 1; i <= remainder; i++) {
    cells.push({ key: `post-${i}`, date: null, day: i, inMonth: false });
  }

  // Footer now flows in normal layout below the grid, so we no
  // longer need the legacy ~50px padding-bottom that used to leave
  // room for the absolutely-positioned footer.
  return (
    <div className="relative min-w-[268px] px-4 pb-2 pt-3">
      <div className="mb-2.5 flex items-center justify-between">
        <button
          type="button"
          onClick={onPrev}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-orange-bg hover:text-orange"
        >
          ◀
        </button>
        <div className="select-none text-sm font-bold text-ink">
          {year}年 {monthNames[month]}
        </div>
        <button
          type="button"
          onClick={onNext}
          className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-orange-bg hover:text-orange"
        >
          ▶
        </button>
      </div>
      <div className="mb-0.5 grid grid-cols-7">
        {["日", "一", "二", "三", "四", "五", "六"].map((w) => (
          <div
            key={w}
            className="select-none py-1 text-center text-[11px] font-semibold text-gray-300"
          >
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px">
        {cells.map((cell) => {
          if (!cell.inMonth) {
            return (
              <button
                key={cell.key}
                type="button"
                disabled
                className="h-9 text-xs text-border md:h-8"
              >
                {cell.day}
              </button>
            );
          }
          const ds = cell.date as string;
          const isFrom = ds === from;
          const isTo = ds === to;
          const inRange = !!from && !!to && ds > from && ds < to;
          const isToday = ds === today;
          const selected = isFrom || isTo;
          const rangeSingle = from && to && from === to;

          return (
            <button
              key={ds}
              type="button"
              onClick={() => onSelectDay(ds)}
              className={cn(
                "flex h-9 cursor-pointer items-center justify-center font-sans text-[13px] transition-colors duration-75 md:h-8 md:text-xs",
                selected && "bg-orange font-semibold text-white",
                selected && !rangeSingle && isFrom && "rounded-l-lg",
                selected && !rangeSingle && isTo && "rounded-r-lg",
                rangeSingle && selected && "rounded-lg",
                inRange && "bg-orange-bg text-orange",
                !selected && !inRange && isToday && "font-bold text-orange",
                !selected && !inRange && "hover:bg-orange-bg active:bg-orange-bg",
              )}
            >
              {cell.day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

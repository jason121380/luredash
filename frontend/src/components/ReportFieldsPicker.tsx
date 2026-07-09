import { cn } from "@/lib/cn";
import {
  DEFAULT_REPORT_FIELDS,
  REPORT_FIELDS,
  addReportFieldOrdered,
  moveReportField,
  selectAllReportFields,
  toggleReportField,
} from "@/lib/reportFields";
import { useState } from "react";

/**
 * Multi-select chip picker for report KPI fields.
 *
 * Two modes:
 *   - default (LINE 推播設定): flat chip grid, tap to toggle, order is
 *     always the catalog order.
 *   - `reorderable` (dashboard report modal): selected chips render
 *     first, in the user's chosen order, and can be dragged to reorder;
 *     the value array's order is meaningful and preserved. Unselected
 *     chips follow, tap to add (appended to the end).
 *
 * Mutex groups (spend / spend_plus) auto-deselect siblings in both
 * modes. 「全選」/「還原預設」 behave the same.
 */
export interface ReportFieldsPickerProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** Enable drag-to-reorder of selected chips (dashboard report). */
  reorderable?: boolean;
}

const LABEL_BY_CODE = new Map(REPORT_FIELDS.map((f) => [f.code, f.label] as const));

export function ReportFieldsPicker({
  value,
  onChange,
  reorderable = false,
}: ReportFieldsPickerProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold text-ink">報告欄位</span>
        <div className="flex items-center gap-2 text-[11px] text-gray-300">
          <button
            type="button"
            onClick={() => onChange(selectAllReportFields())}
            className="hover:text-orange"
          >
            全選
          </button>
          <span className="text-gray-300/60">|</span>
          <button
            type="button"
            onClick={() => onChange([...DEFAULT_REPORT_FIELDS])}
            className="hover:text-orange"
          >
            還原預設
          </button>
        </div>
      </div>

      {reorderable ? (
        <ReorderableChips value={value} onChange={onChange} />
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {REPORT_FIELDS.map((field) => {
            const selected = value.includes(field.code);
            return (
              <button
                key={field.code}
                type="button"
                onClick={() => onChange(toggleReportField(value, field.code))}
                className={cn(
                  "h-7 rounded-full border px-2.5 text-[11px] font-semibold transition",
                  selected
                    ? "border-orange bg-orange-bg text-orange"
                    : "border-border bg-white text-gray-500 hover:border-orange",
                )}
                aria-pressed={selected}
              >
                {field.label}
              </button>
            );
          })}
        </div>
      )}

      {value.length === 0 && (
        <span className="text-[10px] text-red">至少選一個欄位,否則報告會是空的</span>
      )}
    </div>
  );
}

function ReorderableChips({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const unselected = REPORT_FIELDS.filter((f) => !value.includes(f.code));

  const onDrop = (targetIndex: number) => {
    if (dragIndex === null) return;
    onChange(moveReportField(value, dragIndex, targetIndex));
    setDragIndex(null);
  };

  return (
    <div className="flex flex-col gap-2">
      {/* Selected — draggable, in chosen order. 拖曳可調整報告顯示順序。 */}
      <div>
        <div className="mb-1 text-[10px] text-gray-400">已選(拖曳可排序)</div>
        {value.length === 0 ? (
          <div className="text-[11px] text-gray-300">尚未選擇欄位</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {value.map((code, i) => (
              <div
                key={code}
                draggable
                onDragStart={() => setDragIndex(i)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={() => onDrop(i)}
                onDragEnd={() => setDragIndex(null)}
                className={cn(
                  "flex h-7 cursor-grab items-center gap-1 rounded-full border border-orange bg-orange-bg px-2 text-[11px] font-semibold text-orange active:cursor-grabbing",
                  dragIndex === i && "opacity-40",
                )}
              >
                <span aria-hidden="true" className="text-orange/50">
                  ⠿
                </span>
                <span>{LABEL_BY_CODE.get(code) ?? code}</span>
                <button
                  type="button"
                  aria-label={`移除 ${LABEL_BY_CODE.get(code) ?? code}`}
                  onClick={() => onChange(value.filter((c) => c !== code))}
                  className="ml-0.5 text-orange/60 hover:text-orange"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Unselected — tap to add (appended to the end). */}
      {unselected.length > 0 && (
        <div>
          <div className="mb-1 text-[10px] text-gray-400">可加入</div>
          <div className="flex flex-wrap gap-1.5">
            {unselected.map((field) => (
              <button
                key={field.code}
                type="button"
                onClick={() => onChange(addReportFieldOrdered(value, field.code))}
                className="h-7 rounded-full border border-border bg-white px-2.5 text-[11px] font-semibold text-gray-500 transition hover:border-orange"
              >
                + {field.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

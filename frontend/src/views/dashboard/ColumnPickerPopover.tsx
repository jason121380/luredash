import { cn } from "@/lib/cn";
import { useUiStore } from "@/stores/uiStore";
import * as Popover from "@radix-ui/react-popover";
import { useState } from "react";
import { EXTRA_TREE_COLS, type TreeColKey } from "./treeCols";

/**
 * Columns-icon trigger that opens a popover for toggling the optional
 * e-commerce KPI columns (連結點擊 / 加入購物車 / 購買數 / ROAS …).
 *
 * Persisted via uiStore.extraTreeCols → localStorage. Default empty
 * so first-time users see the same 11-column legacy layout.
 */
export function ColumnPickerPopover() {
  const [open, setOpen] = useState(false);
  const extras = useUiStore((s) => s.extraTreeCols);
  const setExtras = useUiStore((s) => s.setExtraTreeCols);

  const enabled = new Set(extras);
  const toggle = (code: TreeColKey) => {
    const next = new Set(enabled);
    if (next.has(code)) next.delete(code);
    else next.add(code);
    setExtras(EXTRA_TREE_COLS.filter((c) => next.has(c.key)).map((c) => c.key));
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          title="自訂指標欄位"
          aria-label="自訂指標欄位"
          aria-pressed={extras.length > 0}
          className={cn(
            "relative flex h-9 w-9 items-center justify-center rounded-xl border-[1.5px] text-ink active:scale-95",
            extras.length > 0 || open
              ? "border-orange bg-orange-bg text-orange"
              : "border-border bg-white hover:border-orange-border hover:bg-orange-bg hover:text-orange",
          )}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <line x1="9" y1="4" x2="9" y2="20" />
            <line x1="15" y1="4" x2="15" y2="20" />
          </svg>
          {extras.length > 0 && (
            <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-orange px-1 text-[10px] font-bold text-white">
              {extras.length}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          collisionPadding={12}
          className={cn(
            "z-[999] w-[260px] overflow-hidden rounded-2xl border-[1.5px] border-border bg-white",
            "shadow-[0_12px_48px_rgba(0,0,0,0.12)] animate-fade-in",
          )}
        >
          <div className="border-b border-border px-4 py-3">
            <div className="text-[13px] font-bold text-ink">自訂指標欄位</div>
            <div className="mt-0.5 text-[11px] text-gray-300">勾選後會出現在表格中</div>
          </div>
          <div className="flex flex-col p-1.5">
            {EXTRA_TREE_COLS.map((col) => {
              const checked = enabled.has(col.key);
              return (
                <label
                  key={col.key}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-[13px]",
                    "transition-colors duration-100",
                    checked ? "bg-orange-bg font-semibold text-orange" : "hover:bg-bg",
                  )}
                >
                  <input
                    type="checkbox"
                    className="custom-cb"
                    checked={checked}
                    onChange={() => toggle(col.key)}
                  />
                  <span className="flex-1">{col.label}</span>
                </label>
              );
            })}
          </div>
          {extras.length > 0 && (
            <div className="border-t border-border px-2 py-2">
              <button
                type="button"
                onClick={() => setExtras([])}
                className="w-full rounded-lg px-3 py-1.5 text-[12px] text-gray-500 hover:bg-bg hover:text-orange"
              >
                清除全部
              </button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

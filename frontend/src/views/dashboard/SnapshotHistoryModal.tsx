import { type ReportSnapshotListItem, api } from "@/api/client";
import { Button } from "@/components/Button";
import { toast } from "@/components/Toast";
import { cn } from "@/lib/cn";
import { buildSnapshotShareUrl } from "@/lib/shareReport";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

/**
 * 生成紀錄 — full-screen page listing the report snapshots generated for
 * one campaign. Each row has its own permanent share link (frozen data,
 * zero FB calls) that the operator can copy, open, or delete.
 *
 * Rendered as a full-window overlay (not the centered Modal) with a back
 * arrow top-left; it sits above the report modal (z-951 > z-901) and
 * returns to it on 返回.
 */
export function SnapshotHistoryModal({
  open,
  onOpenChange,
  campaignId,
  campaignLabel,
  variant,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  campaignId: string;
  campaignLabel: string;
  /** The report version the user opened 生成紀錄 from — the tab defaults
   *  here so they land on the matching records. */
  variant: "standard" | "perf";
}) {
  const qc = useQueryClient();
  // 拆成兩個分頁(以廣告組合報告 / 以廣告報告);預設落在當下的版本,
  // 每個分頁只列該版本的紀錄。
  const [tab, setTab] = useState<"standard" | "perf">(variant);
  useEffect(() => {
    if (open) setTab(variant);
  }, [open, variant]);

  const q = useQuery({
    queryKey: ["report-snapshots", campaignId],
    queryFn: () => api.reportSnapshots.list(campaignId, null),
    enabled: open,
    staleTime: 30_000,
  });
  const del = useMutation({
    mutationFn: (id: string) => api.reportSnapshots.remove(id, null),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["report-snapshots", campaignId] });
      toast("已刪除紀錄", "success", 2000);
    },
    onError: () => toast("刪除失敗,請重試", "error", 2500),
  });

  const allRows = q.data?.data ?? [];
  const rows = allRows.filter((s) => s.variant === tab);
  const counts = {
    standard: allRows.filter((s) => s.variant === "standard").length,
    perf: allRows.filter((s) => s.variant === "perf").length,
  };

  const copy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(buildSnapshotShareUrl(id));
      toast("已複製分享連結", "success", 2000);
    } catch {
      /* clipboard blocked on insecure context */
    }
  };
  const openLink = (id: string) =>
    window.open(buildSnapshotShareUrl(id), "_blank", "noopener,noreferrer");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[950] bg-black/40 md:animate-fade-in" />
        <Dialog.Content className="fixed inset-0 z-[951] flex flex-col bg-bg focus:outline-none md:animate-fade-in">
          {/* Header — back arrow top-left. On mobile the white header
              extends up under the iOS status bar / notch (safe-area top
              inset) so the 返回 button is reachable, not hidden. */}
          <div className="flex items-center gap-2.5 border-border border-b bg-white px-3 pb-2.5 pt-[calc(env(safe-area-inset-top)+0.625rem)] md:px-4 md:py-3">
            <button
              type="button"
              aria-label="返回"
              onClick={() => onOpenChange(false)}
              onPointerUp={() => onOpenChange(false)}
              style={{ touchAction: "manipulation" }}
              className="-ml-1 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-500 hover:bg-bg hover:text-ink"
            >
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className="pointer-events-none"
              >
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </button>
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-[15px] font-bold text-ink md:text-base">
                生成紀錄
              </Dialog.Title>
              <Dialog.Description className="truncate text-[11px] text-gray-500">
                {campaignLabel}
              </Dialog.Description>
            </div>
          </div>

          {/* Tab bar — 以廣告組合報告 / 以廣告報告. */}
          <div className="border-border border-b bg-white px-3 md:px-4">
            <div className="mx-auto flex w-full max-w-[720px] gap-1">
              {(["standard", "perf"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setTab(v)}
                  className={cn(
                    "-mb-px border-b-2 px-3 py-2.5 text-[13px] font-semibold transition-colors",
                    tab === v
                      ? "border-orange text-orange"
                      : "border-transparent text-gray-400 hover:text-ink",
                  )}
                  aria-pressed={tab === v}
                >
                  {v === "perf" ? "以廣告報告" : "以廣告組合報告"}
                  <span className="ml-1 text-[11px] text-gray-400">({counts[v]})</span>
                </button>
              ))}
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-3 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-4">
            <div className="mx-auto w-full max-w-[720px]">
              {q.isLoading ? (
                <div className="px-1 py-10 text-center text-[13px] text-gray-300">載入中...</div>
              ) : q.isError ? (
                <div className="px-1 py-10 text-center text-[13px] text-red">
                  載入失敗:{q.error instanceof Error ? q.error.message : "未知錯誤"}
                </div>
              ) : rows.length === 0 ? (
                <div className="px-1 py-10 text-center text-[13px] text-gray-300">
                  尚無紀錄,回報告按「生成報告」建立第一份。
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {rows.map((s) => (
                    <SnapshotRow
                      key={s.id}
                      snapshot={s}
                      onCopy={() => copy(s.id)}
                      onOpen={() => openLink(s.id)}
                      onDelete={() => del.mutate(s.id)}
                      deleting={del.isPending}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SnapshotRow({
  snapshot,
  onCopy,
  onOpen,
  onDelete,
  deleting,
}: {
  snapshot: ReportSnapshotListItem;
  onCopy: () => void;
  onOpen: () => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const when = snapshot.created_at
    ? new Date(snapshot.created_at).toLocaleString("zh-TW", { hour12: false })
    : "—";
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-white px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-ink">{snapshot.date_label || "報告"}</div>
        <div className="mt-0.5 truncate text-[12px] text-gray-400">生成於 {when}</div>
      </div>
      <Button variant="ghost" size="sm" onClick={onCopy}>
        複製連結
      </Button>
      <Button variant="ghost" size="sm" onClick={onOpen}>
        開啟
      </Button>
      <button
        type="button"
        onClick={onDelete}
        disabled={deleting}
        className="shrink-0 px-1 text-[12px] text-red hover:underline disabled:opacity-50"
      >
        刪除
      </button>
    </div>
  );
}

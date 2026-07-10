import { type ReportSnapshotListItem, api } from "@/api/client";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/Toast";
import { buildSnapshotShareUrl } from "@/lib/shareReport";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * 快照紀錄 — history of generated report snapshots for one campaign.
 * Each row has its own permanent share link (frozen data, zero FB calls)
 * that the operator can copy, open, or delete.
 */
export function SnapshotHistoryModal({
  open,
  onOpenChange,
  campaignId,
  campaignLabel,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  campaignId: string;
  campaignLabel: string;
}) {
  const qc = useQueryClient();
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
      toast("已刪除快照", "success", 2000);
    },
    onError: () => toast("刪除失敗,請重試", "error", 2500),
  });

  const rows = q.data?.data ?? [];

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
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="快照紀錄"
      subtitle={campaignLabel}
      width={640}
    >
      {q.isLoading ? (
        <div className="px-1 py-8 text-center text-[13px] text-gray-300">載入中...</div>
      ) : q.isError ? (
        <div className="px-1 py-8 text-center text-[13px] text-red">
          載入失敗:{q.error instanceof Error ? q.error.message : "未知錯誤"}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-1 py-8 text-center text-[13px] text-gray-300">
          尚無快照,回報告按「生成快照」建立第一個。
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
    </Modal>
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
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-full border border-border px-2 py-[1px] text-[11px] text-gray-500">
            {snapshot.variant === "perf" ? "以廣告報告" : "以廣告組合報告"}
          </span>
          {snapshot.date_label && (
            <span className="text-[11px] text-gray-400">{snapshot.date_label}</span>
          )}
        </div>
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

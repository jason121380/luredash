import { mutationErrorMessage, useEntityStatusMutation } from "@/api/hooks/useEntityMutations";
import { usePageInfo } from "@/api/hooks/usePageInfo";
import { Badge } from "@/components/Badge";
import { confirm } from "@/components/ConfirmDialog";
import { toast } from "@/components/Toast";
import { Toggle } from "@/components/Toggle";
import { isFrontPostCreative, pageIdFromStoryId } from "@/lib/fbLinks";
import { fM, fN, fP } from "@/lib/format";
import { getIns, getMsgCount } from "@/lib/insights";
import { useFinanceStore } from "@/stores/financeStore";
import type { FbCreativeEntity, FbEntityStatus } from "@/types/fb";
import { Suspense, lazy, memo, useEffect, useState } from "react";
import { ExtraTreeCells, SpendPlusCell } from "./ExtraTreeCells";

// The preview modal pulls in <video>, usePostMedia, usePageInfo, and
// FB-post-style header rendering — ~5KB of JS + its own query hooks.
// It only opens when the user actually clicks a creative row, so we
// don't want to ship it in the Dashboard first-paint bundle. Lazy-
// loading keeps the tree render path lean.
const CreativePreviewModal = lazy(() =>
  import("@/components/CreativePreviewModal").then((m) => ({
    default: m.CreativePreviewModal,
  })),
);

/**
 * Third-level row — a single FB Ad / creative.
 *
 * CRITICAL: the table row MUST use the class `creative-row`, NOT
 * `ad-row`. Ad blockers (uBlock, AdBlock Plus) match `[class^="ad-"]`
 * and set `display: none` on any element whose class starts with
 * `ad-`, which is how we got into the silent-breakage saga that led
 * to commit d720fa2. Enforced by a dedicated eslint-style grep check
 * added in Phase 10.
 */

export interface CreativeRowProps {
  creative: FbCreativeEntity;
  multiAcct: boolean;
  /** Forwarded to <CreativePreviewModal/> as the download filename
   *  root — undefined for flat views (素材比較) where there is no
   *  single parent campaign. */
  campaignName?: string;
  extras: string[];
  /** Parent campaign markup % for the 花費+% cell. Undefined in the flat
   *  素材比較 view (no single parent campaign) → falls back to the team
   *  default markup. */
  spendPlusMarkup?: number;
}

function CreativeRowInner({
  creative,
  multiAcct,
  campaignName,
  extras,
  spendPlusMarkup,
}: CreativeRowProps) {
  const defaultMarkup = useFinanceStore((s) => s.defaultMarkup);
  const showSpendPlus = extras.includes("spend_plus");
  const markupPercent = spendPlusMarkup ?? defaultMarkup;
  const ins = getIns(creative);
  const msgs = getMsgCount(creative);
  const spend = Number(ins.spend) || 0;
  const mutation = useEntityStatusMutation();
  const thumb = creative.creative?.thumbnail_url;
  const isFrontPost = creative.creative ? isFrontPostCreative(creative.creative) : false;
  // Which FB Page this ad publishes under. `effective_object_story_id`
  // is present on virtually every ad (FB creates a dark post even for
  // inline creatives), so the chip renders for both front- and
  // back-stage ads. React Query dedupes by pageId across rows and the
  // backend caches page info for 1h, so a 50-row adset costs at most
  // one FB call per distinct page.
  const pageId = pageIdFromStoryId(creative.creative?.effective_object_story_id);
  const pageQuery = usePageInfo(pageId, true);
  const page = pageQuery.data;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<FbEntityStatus | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: trigger-only dep — clear optimistic override whenever server status changes
  useEffect(() => {
    setPendingStatus(null);
  }, [creative.status]);
  const displayStatus = pendingStatus ?? creative.status;

  const onToggleStatus = async (nextChecked: boolean) => {
    const status: FbEntityStatus = nextChecked ? "ACTIVE" : "PAUSED";
    const action = nextChecked ? "開啟" : "暫停";
    const ok = await confirm(`確定要${action}此廣告？`);
    if (!ok) return;
    setPendingStatus(status);
    try {
      await mutation.mutateAsync({ kind: "creative", id: creative.id, status });
      toast(`已${action}廣告`, "success");
    } catch (e) {
      setPendingStatus(null);
      toast(`${action}廣告失敗：${mutationErrorMessage(e)}`, "error", 4500);
    }
  };

  const canPreview = Boolean(thumb);
  const openPreview = () => {
    if (canPreview) setPreviewOpen(true);
  };

  return (
    <>
      <tr
        className={canPreview ? "creative-row cursor-zoom-in" : "creative-row"}
        onClick={openPreview}
      >
        <td />
        <td>
          <div className="flex max-w-[340px] items-center gap-1.5 pl-[72px]">
            {thumb ? (
              // NOTE: do NOT wrap the URL in escHtml(). The legacy
              // the original design did so because it injected the <img> via
              // innerHTML, where the browser re-parses `&amp;` back to
              // `&`. In React JSX, `src={...}` is an attribute binding,
              // so escHtml would leave `&amp;` literally in the URL and
              // break Facebook's signed CDN URLs (signature mismatch →
              // 403 → broken thumbnail). See the 3rd-level ad thumbnail
              // regression investigated 2026-04-14.
              <img
                src={thumb}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-[30px] w-[30px] shrink-0 rounded-sm border border-border object-cover"
              />
            ) : (
              <div className="h-[30px] w-[30px] shrink-0 rounded-sm bg-bg" />
            )}
            <span className="truncate text-[13px] font-normal text-gray-500" title={creative.name}>
              {creative.name}
            </span>
            {isFrontPost && (
              <span
                className="shrink-0 rounded-full bg-[#E3F2FD] px-1.5 py-[1px] text-[10px] font-semibold text-[#1565C0]"
                title="這支廣告是從既有的 FB/IG 貼文建立"
              >
                前台貼文
              </span>
            )}
            {page?.name && (
              <span className="flex shrink-0 items-center gap-1" title={`粉絲專頁：${page.name}`}>
                {page.picture_url && (
                  <img
                    src={page.picture_url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    className="h-4 w-4 shrink-0 rounded-full border border-border object-cover"
                  />
                )}
                <span className="max-w-[90px] truncate text-[11px] text-gray-300">{page.name}</span>
              </span>
            )}
          </div>
        </td>
        {multiAcct && <td />}
        <td>
          <Badge status={displayStatus} />
        </td>
        <td className="num">{fM(ins.spend)}</td>
        <SpendPlusCell show={showSpendPlus} spend={spend} markupPercent={markupPercent} />
        <td className="num">{fN(ins.impressions)}</td>
        <td className="num">{fN(ins.clicks)}</td>
        <td className="num">{fP(ins.ctr)}</td>
        <td className="num">{fM(ins.cpc)}</td>
        <td className="num">{msgs > 0 ? fN(msgs) : "—"}</td>
        <td className="num">{msgs > 0 ? `$${fM(spend / msgs)}` : "—"}</td>
        <ExtraTreeCells entity={creative} extras={extras} />
        <td className="muted">—</td>
        <td onClick={(e) => e.stopPropagation()}>
          <Toggle
            checked={displayStatus === "ACTIVE"}
            disabled={mutation.isPending}
            onChange={(e) => {
              void onToggleStatus(e.currentTarget.checked);
            }}
          />
        </td>
      </tr>
      {previewOpen && (
        <Suspense fallback={null}>
          <CreativePreviewModal
            creative={creative}
            campaignName={campaignName}
            onClose={() => setPreviewOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}

/**
 * Exported memoised wrapper. The creative prop is stable across
 * re-renders of the parent <AdsetRow/> (it comes from React Query's
 * cached array), so `memo` short-circuits 95%+ of tree renders when
 * the user sorts / filters / toggles expansion elsewhere in the tree.
 */
export const CreativeRow = memo(CreativeRowInner);

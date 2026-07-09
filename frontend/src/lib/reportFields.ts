/**
 * 共用的 LINE flex 推播報告欄位常數 + 工具。給
 * `views/settings/GroupPushConfigModal.tsx` (LINE 推播設定 → 群組推播) 使用。
 *
 * code 必須跟 backend `_build_flex_for_config` 內的 `field_catalog`
 * 鍵值一致,否則新增/移除欄位時會兩邊不同步。
 */

export interface ReportFieldDef {
  code: string;
  label: string;
}

export const REPORT_FIELDS: ReportFieldDef[] = [
  { code: "spend", label: "花費" },
  { code: "spend_plus", label: "花費+%" },
  { code: "impressions", label: "曝光" },
  { code: "clicks", label: "點擊" },
  { code: "ctr", label: "CTR" },
  { code: "cpc", label: "CPC" },
  { code: "cpm", label: "CPM" },
  { code: "frequency", label: "頻次" },
  { code: "reach", label: "觸及" },
  { code: "msgs", label: "私訊數" },
  { code: "msg_cost", label: "私訊成本" },
  { code: "link_clicks", label: "連結點擊" },
  { code: "cost_per_link_click", label: "連結點擊成本" },
  { code: "add_to_cart", label: "加入購物車" },
  { code: "cost_per_add_to_cart", label: "加入購物車成本" },
  { code: "purchases", label: "購買數" },
  { code: "cost_per_purchase", label: "購買成本" },
  { code: "roas", label: "ROAS" },
];

/** 互斥群組 — 同一陣列內的 code 在 multi-select 內只能擇一。
 *  目前僅有「花費 / 花費+%」需要互斥(同一份報告不會同時放原始花費
 *  跟加成後的花費)。 */
export const MUTEX_GROUPS: string[][] = [["spend", "spend_plus"]];

/** 預設選擇 — 與 backend 內建預設一致 (spend 而非 spend_plus,
 *  因為對內監控通常想看真實花費)。 */
export const DEFAULT_REPORT_FIELDS = [
  "spend",
  "impressions",
  "clicks",
  "ctr",
  "cpc",
  "msgs",
  "msg_cost",
];

/** 計算「全選」時的 code 陣列 — 互斥群組各只取第一個 code 避免
 *  spend / spend_plus 被同時勾起。 */
export function selectAllReportFields(): string[] {
  const blocked = new Set<string>();
  for (const group of MUTEX_GROUPS) {
    for (const code of group.slice(1)) blocked.add(code);
  }
  return REPORT_FIELDS.filter((f) => !blocked.has(f.code)).map((f) => f.code);
}

/** Toggle 一個 code 的勾選狀態,並依 mutex 規則自動清掉同群組的
 *  其他 code。回傳依 catalog 順序排好的新 code 陣列。 */
export function toggleReportField(current: string[], code: string): string[] {
  const set = new Set(current);
  if (set.has(code)) {
    set.delete(code);
  } else {
    for (const group of MUTEX_GROUPS) {
      if (group.includes(code)) {
        for (const sibling of group) {
          if (sibling !== code) set.delete(sibling);
        }
      }
    }
    set.add(code);
  }
  return REPORT_FIELDS.filter((f) => set.has(f.code)).map((f) => f.code);
}

/** 從 server config 的 report_fields 解析:空陣列 → fallback 到預設。 */
export function normalizeReportFields(input: string[] | null | undefined): string[] {
  if (input?.length) return input;
  return [...DEFAULT_REPORT_FIELDS];
}

/** 加入一個 code,**保留使用者現有順序**、把新的接在最後(reorderable
 *  模式用,不像 toggleReportField 會重排成 catalog 順序)。同 mutex 群組
 *  的其他 code 會被移除。 */
export function addReportFieldOrdered(current: string[], code: string): string[] {
  const blocked = new Set<string>();
  for (const group of MUTEX_GROUPS) {
    if (group.includes(code)) {
      for (const sibling of group) if (sibling !== code) blocked.add(sibling);
    }
  }
  const kept = current.filter((c) => c !== code && !blocked.has(c));
  return [...kept, code];
}

/** 把 `from` 位置的 code 搬到 `to` 位置(拖曳排序用)。索引越界時原樣回傳。 */
export function moveReportField(current: string[], from: number, to: number): string[] {
  if (from === to || from < 0 || to < 0 || from >= current.length || to >= current.length) {
    return current;
  }
  const next = [...current];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return current;
  next.splice(to, 0, moved);
  return next;
}

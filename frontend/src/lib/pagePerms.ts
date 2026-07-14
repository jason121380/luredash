/**
 * Sidebar pages that admins can grant / revoke per user (頁面權限). The
 * `key` matches the nav route (`NavItem.to`). Kept in one place so the
 * 用戶列表 checkboxes and the Sidebar filter never drift.
 */
export interface GatedPage {
  key: string;
  label: string;
}

export const GATED_PAGES: GatedPage[] = [
  { key: "/dashboard", label: "儀表板" },
  { key: "/analytics", label: "數據圖表" },
  { key: "/security", label: "安全防護" },
  { key: "/alerts", label: "警示列表" },
  { key: "/optimization", label: "優化中心" },
  { key: "/finance", label: "費用中心" },
  { key: "/store-expenses", label: "店家花費" },
  { key: "/history", label: "歷史花費" },
  { key: "/settings", label: "廣告帳號" },
  { key: "/line-push", label: "LINE 推播" },
  { key: "/billing", label: "我的訂閱" },
];

export const ALL_PAGE_KEYS = GATED_PAGES.map((p) => p.key);

/**
 * Whether a user may see a page. `perms == null` means all pages are
 * allowed (the default). Admins always bypass the restriction so they
 * can't lock themselves out.
 */
export function canSeePage(
  key: string,
  perms: string[] | null | undefined,
  isAdmin: boolean,
): boolean {
  if (isAdmin) return true;
  if (perms == null) return true;
  return perms.includes(key);
}

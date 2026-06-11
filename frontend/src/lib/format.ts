/**
 * Number / percentage / money / frequency formatters.
 *
 * These are literal ports of the global `fN`, `fM`, `fP`, `fF`, `escHtml`
 * helpers defined in the original design around lines 1282–1286. The formatting
 * is part of the UI contract — every stats row, tree cell, finance row,
 * and chart axis relies on these exact outputs. Any change here will
 * cause visible drift, so they must match the legacy output byte-for-byte.
 *
 * Examples (all in zh-TW locale):
 *   fN(1234567)     → "1,234,567"
 *   fN(1234.5, 2)   → "1,234.50"
 *   fM(1234.5)      → "1,235"             (rounded to integer)
 *   fP(3.1416)      → "3.14%"
 *   fF(3.1416)      → "3.14"              (no trailing %)
 *   fN(null)        → "—"                 (em dash placeholder)
 *   fN(undefined)   → "—"
 *   fN("")          → "—"
 */

type Numeric = number | string | null | undefined;

/**
 * Format a number with thousands separators and fixed decimal digits.
 * Returns "—" for null, undefined, or empty string — matching the
 * legacy dashboard's placeholder behavior.
 */
export function fN(n: Numeric, decimals = 0): string {
  if (n === null || n === undefined || n === "") return "—";
  return Number(n).toLocaleString("zh-TW", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Money formatter. Integer-only ("$1,234"), no decimals. Used for spend,
 * CPC, CPM, msgCost. The `$` prefix is added by the call site, not here
 * — legacy behavior.
 */
export function fM(n: Numeric): string {
  return fN(n, 0);
}

/**
 * Percentage formatter. `3.1416` → `"3.14%"`. The `%` is included.
 */
export function fP(n: Numeric): string {
  if (n === null || n === undefined || n === "") return "—";
  return `${Number(n).toFixed(2)}%`;
}

/**
 * Frequency formatter. `3.1416` → `"3.14"`. No `%`, no commas.
 * Used for the `frequency` field of FB insights.
 */
export function fF(n: Numeric): string {
  if (n === null || n === undefined || n === "") return "—";
  return Number(n).toFixed(2);
}

/**
 * Format a Page's `displayed_message_response_time` for display.
 *
 * This is the responsiveness value the page DISPLAYS to visitors
 * (the「一般會在幾分鐘內回覆」badge source) — NOT the live measured
 * response time from Business Suite. Observed raw values: the
 * literal "AUTOMATIC" (page lets FB decide — nothing concrete to
 * show, return null), a number of minutes as digits, or a bucket
 * enum. Unknown values return null so we never surface raw English
 * enum strings in the UI.
 */
export function formatPageResponseTime(v: string | null | undefined): string | null {
  if (!v) return null;
  const upper = v.toUpperCase();
  if (upper === "AUTOMATIC") return null;
  if (/^\d+$/.test(v)) {
    const mins = Number(v);
    if (mins <= 0) return null;
    if (mins >= 1440) return `通常於 ${Math.round(mins / 1440)} 天內回覆`;
    if (mins >= 60) return `通常於 ${Math.round(mins / 60)} 小時內回覆`;
    return `通常於 ${mins} 分鐘內回覆`;
  }
  const buckets: Record<string, string> = {
    FEW_MINUTES: "通常於幾分鐘內回覆",
    WITHIN_AN_HOUR: "通常於 1 小時內回覆",
    FEW_HOURS: "通常於幾小時內回覆",
    WITHIN_A_DAY: "通常於 1 天內回覆",
    FEW_DAYS: "通常於幾天內回覆",
  };
  return buckets[upper] ?? null;
}

/**
 * Escape HTML special characters. React usually handles this for us,
 * but we need a string version for chart tooltip callbacks and
 * `dangerouslySetInnerHTML` cases.
 */
export function escHtml(s: Numeric): string {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

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

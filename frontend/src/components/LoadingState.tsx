import { cn } from "@/lib/cn";
import { type ReactNode, useEffect, useState } from "react";

/**
 * Prominent loading state — larger and clearer than the tiny
 * <Loading/> primitive. Designed for the "user opens a view and
 * waits for multi-account data" case. Shows:
 *
 *   - A bold title line ("載入資料中...")
 *   - A percentage number that counts up during the wait
 *   - A 3x3 blocks-shuffle loader in the product orange gradient
 *
 * Designed to look OBVIOUSLY different from an empty state — no
 * gray-300 text, no ambiguous "—" placeholder, no risk the user
 * thinks the screen is broken.
 *
 * How the percentage works (IMPORTANT):
 *
 * The dashboard's batched `/api/overview` endpoint is a SINGLE
 * backend round-trip. From the browser's point of view it's either
 * in-flight or done — there's no intermediate "2/N accounts" state
 * to surface honestly. The old UI exposed `loaded/total` counters
 * that sat at 0/N the whole time and snapped to N/N at the end,
 * which was indistinguishable from a broken bar.
 *
 * This version uses a TIME-BASED fake progress curve that sweeps
 * smoothly from 0% to ~90% while the request is in flight, then
 * snaps to 100% as soon as the component unmounts (the parent
 * switches to the real data view). The sweep uses an asymptotic
 * `1 - e^(-t/tau)` curve so it slows down as it approaches the
 * cap, which matches the "long tail" feel of real network waits
 * and never lies that we're 99% done when we've only been waiting
 * 200ms. Total expected duration is driven by `estimatedDurationMs`
 * (default 4s for `/api/overview` against 80 accounts).
 *
 * If the caller passes `loaded`/`total` counts from per-account
 * queries (the legacy `useQueries` fan-out, e.g. used during
 * per-adset creative fetches), those take precedence and drive the
 * bar honestly — we detect that mode via `total > 1 && loaded`.
 */

export interface LoadingStateProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Optional per-query progress counts. When provided AND honest
   * (i.e. `loaded` increments as real queries resolve), the bar
   * follows them. Leave undefined to use the time-based curve. */
  loaded?: number;
  total?: number;
  /** How long the caller expects the load to take, in ms. Used to
   * shape the time-based fake-progress curve. Default 4000ms. */
  estimatedDurationMs?: number;
  /** Optional hint line below the percentage — use to set user
   * expectations about how long the load usually takes. */
  hint?: ReactNode;
  className?: string;
}

// Percentage cap for the fake time-based curve. The bar asymptotes
// here rather than reaching 100% so we don't lie about being done —
// the caller unmounts us when the real data arrives and the parent
// view takes over.
const FAKE_CAP = 92;
// Animation tick resolution. 16ms ≈ 60fps; anything faster is
// wasted since the <100 rerenders/sec eye can't tell the difference
// and browsers throttle setInterval below 4ms anyway.
const TICK_MS = 50;

/** 1 - e^(-t/tau), scaled to FAKE_CAP. `tau = duration / 3` puts
 * the curve at ~63% of the cap after one-third of the expected
 * duration, ~86% after two-thirds, asymptotic after that. */
function fakePercent(elapsedMs: number, durationMs: number): number {
  const tau = Math.max(1, durationMs / 3);
  const raw = 1 - Math.exp(-elapsedMs / tau);
  return Math.min(FAKE_CAP, raw * FAKE_CAP);
}

export function LoadingState({
  title = "載入資料中...",
  subtitle,
  loaded,
  total,
  estimatedDurationMs = 4000,
  hint,
  className,
}: LoadingStateProps) {
  // Honest mode: `loaded` actually increments as queries resolve.
  // We detect this by checking if the caller provided numbers AND
  // `loaded` is not stuck at zero (the old "0/N until done" lie).
  // If loaded is 0 but total > 0, we fall back to the fake curve
  // so the user still sees motion.
  const loadedSafe = typeof loaded === "number" ? loaded : 0;
  const totalSafe = typeof total === "number" ? total : 0;
  const honest = totalSafe > 1 && loadedSafe > 0;

  // Time-based fake progress ticker. Starts at component mount and
  // runs until we unmount (parent switches to the real view). A
  // single setInterval drives the state so the component rerenders
  // at TICK_MS cadence while visible.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (honest) return; // honest mode doesn't need the ticker
    const start = performance.now();
    const id = setInterval(() => {
      setElapsed(performance.now() - start);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [honest]);

  const pct = honest
    ? Math.min(100, Math.round((loadedSafe / totalSafe) * 100))
    : Math.round(fakePercent(elapsed, estimatedDurationMs));

  const effectiveSubtitle =
    subtitle ?? (honest && totalSafe > 1 ? `${loadedSafe} / ${totalSafe} 個帳戶已載入` : undefined);

  return (
    <div
      className={cn("flex min-h-[220px] flex-col items-center justify-center gap-4 px-6 py-14", className)}
    >
      <div className="text-[16px] font-bold text-ink">{title}</div>
      {effectiveSubtitle && <div className="text-[12px] text-gray-500">{effectiveSubtitle}</div>}
      <div className="flex flex-col items-center gap-2.5">
        <BlocksShuffleLoader />
        <div className="text-[13px] font-semibold tabular-nums text-orange">{pct}%</div>
        <progress value={pct} max={100} className="sr-only" aria-label="載入進度">
          {pct}%
        </progress>
      </div>
      {hint && (
        <div className="mt-1 max-w-[280px] text-center text-[11px] leading-relaxed text-gray-300">
          {hint}
        </div>
      )}
    </div>
  );
}

function BlocksShuffleLoader() {
  return (
    <svg
      width="76"
      height="76"
      viewBox="-13 -13 45 45"
      role="img"
      aria-label="載入中"
      className="overflow-visible"
    >
      <title>載入中</title>
      <defs>
        <linearGradient id="loading-orange-gradient" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#FFB388" />
          <stop offset="45%" stopColor="#FF7A45" />
          <stop offset="100%" stopColor="#FF5A1F" />
        </linearGradient>
      </defs>
      <style>{`
        .loading-block {
          transform-origin: 50% 50%;
          fill: url(#loading-orange-gradient);
        }
        .loading-block:nth-of-type(1) { animation: loadingBlock1 4s infinite; }
        .loading-block:nth-of-type(2) { animation: loadingBlock2 4s infinite; }
        .loading-block:nth-of-type(3) { animation: loadingBlock3 4s infinite; }
        .loading-block:nth-of-type(4) { animation: loadingBlock4 4s infinite; }
        .loading-block:nth-of-type(5) { animation: loadingBlock5 4s infinite; }
        .loading-block:nth-of-type(6) { animation: loadingBlock6 4s infinite; }
        .loading-block:nth-of-type(7) { animation: loadingBlock7 4s infinite; }
        .loading-block:nth-of-type(8) { animation: loadingBlock8 4s infinite; }
        .loading-block:nth-of-type(9) { animation: loadingBlock9 4s infinite; }
        @keyframes loadingBlock1 {
          9.0909% { transform: translate(-12px, 0); }
          18.1818%, 27.2727% { transform: translate(0, 0); }
          36.3636% { transform: translate(12px, 0); }
          45.4545%, 54.5455%, 63.6364% { transform: translate(12px, 12px); }
          72.7273% { transform: translate(12px, 0); }
          81.8182% { transform: translate(0, 0); }
          90.9091% { transform: translate(-12px, 0); }
          100% { transform: translate(0, 0); }
        }
        @keyframes loadingBlock2 {
          9.0909% { transform: translate(0, 0); }
          18.1818% { transform: translate(12px, 0); }
          27.2727% { transform: translate(0, 0); }
          36.3636% { transform: translate(12px, 0); }
          45.4545%, 54.5455%, 63.6364%, 72.7273% { transform: translate(12px, 12px); }
          81.8182%, 90.9091% { transform: translate(0, 12px); }
          100% { transform: translate(0, 0); }
        }
        @keyframes loadingBlock3 {
          9.0909%, 18.1818% { transform: translate(-12px, 0); }
          27.2727% { transform: translate(0, 0); }
          36.3636%, 45.4545%, 54.5455%, 63.6364%, 72.7273% { transform: translate(-12px, 0); }
          81.8182% { transform: translate(-12px, -12px); }
          90.9091% { transform: translate(0, -12px); }
          100% { transform: translate(0, 0); }
        }
        @keyframes loadingBlock4 {
          9.0909%, 18.1818% { transform: translate(-12px, 0); }
          27.2727% { transform: translate(-12px, -12px); }
          36.3636% { transform: translate(0, -12px); }
          45.4545% { transform: translate(0, 0); }
          54.5455%, 63.6364%, 72.7273% { transform: translate(0, -12px); }
          81.8182% { transform: translate(-12px, -12px); }
          90.9091% { transform: translate(-12px, 0); }
          100% { transform: translate(0, 0); }
        }
        @keyframes loadingBlock5 {
          9.0909%, 18.1818%, 27.2727% { transform: translate(0, 0); }
          36.3636%, 45.4545%, 54.5455%, 63.6364%, 72.7273% { transform: translate(12px, 0); }
          81.8182% { transform: translate(12px, -12px); }
          90.9091% { transform: translate(0, -12px); }
          100% { transform: translate(0, 0); }
        }
        @keyframes loadingBlock6 {
          9.0909% { transform: translate(0, 0); }
          18.1818%, 27.2727% { transform: translate(-12px, 0); }
          36.3636%, 45.4545%, 54.5455%, 63.6364% { transform: translate(0, 0); }
          72.7273% { transform: translate(0, 12px); }
          81.8182% { transform: translate(-12px, 12px); }
          90.9091% { transform: translate(-12px, 0); }
          100% { transform: translate(0, 0); }
        }
        @keyframes loadingBlock7 {
          9.0909%, 18.1818%, 27.2727% { transform: translate(12px, 0); }
          36.3636% { transform: translate(0, 0); }
          45.4545% { transform: translate(0, -12px); }
          54.5455% { transform: translate(12px, -12px); }
          63.6364%, 72.7273% { transform: translate(0, -12px); }
          81.8182% { transform: translate(0, 0); }
          90.9091% { transform: translate(12px, 0); }
          100% { transform: translate(0, 0); }
        }
        @keyframes loadingBlock8 {
          9.0909% { transform: translate(0, 0); }
          18.1818% { transform: translate(-12px, 0); }
          27.2727% { transform: translate(-12px, -12px); }
          36.3636%, 45.4545%, 54.5455%, 63.6364%, 72.7273% { transform: translate(0, -12px); }
          81.8182% { transform: translate(12px, -12px); }
          90.9091% { transform: translate(12px, 0); }
          100% { transform: translate(0, 0); }
        }
        @keyframes loadingBlock9 {
          9.0909%, 18.1818% { transform: translate(-12px, 0); }
          27.2727% { transform: translate(0, 0); }
          36.3636% { transform: translate(-12px, 0); }
          45.4545%, 54.5455% { transform: translate(0, 0); }
          63.6364%, 72.7273% { transform: translate(-12px, 0); }
          81.8182% { transform: translate(-24px, 0); }
          90.9091% { transform: translate(-12px, 0); }
          100% { transform: translate(0, 0); }
        }
      `}</style>
      <circle className="loading-block" cx="13" cy="1" r="5" />
      <circle className="loading-block" cx="13" cy="1" r="5" />
      <circle className="loading-block" cx="25" cy="25" r="5" />
      <circle className="loading-block" cx="13" cy="13" r="5" />
      <circle className="loading-block" cx="13" cy="13" r="5" />
      <circle className="loading-block" cx="25" cy="13" r="5" />
      <circle className="loading-block" cx="1" cy="25" r="5" />
      <circle className="loading-block" cx="13" cy="25" r="5" />
      <circle className="loading-block" cx="25" cy="25" r="5" />
    </svg>
  );
}

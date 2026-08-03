/**
 * Browser-side concurrency limiter for FB-backed report fetches.
 *
 * The report / share page auto-expands EVERY adset, and each adset
 * mounts its own breakdown strip (版位/性別/年齡/地區) + ads query. The
 * 4 dims are already chained WITHIN one adset, but ACROSS N adsets every
 * strip fires its first call at mount — an N-wide instant burst of
 * `/insights` requests. That momentary spike can trip FB's app-level
 * burst protection (`code=4`) even when the rolling hourly budget is low
 * (the 8/3 event: `code=4` with `App 0%` — no steady saturation, just a
 * spike).
 *
 * Funnelling those calls through a small FIFO semaphore staggers the
 * burst: total work is unchanged (no call is dropped), only the peak
 * concurrency is capped, so the requests spread over a second or two
 * instead of firing all at once. Backend caching / single-flight still
 * collapse duplicates on top of this.
 */

// Max simultaneous FB-backed report fetches from this tab. 4 keeps the
// report snappy while turning "15 calls in one instant" into a smooth
// trickle well under FB's burst threshold.
const MAX_CONCURRENT = 4;

let active = 0;
const waiting: Array<() => void> = [];

/**
 * Run `fn` under the shared semaphore. Resolves/rejects with `fn`'s
 * result. A slot is always released (even on error) so the queue can
 * never deadlock.
 */
export function limitFb<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      active += 1;
      fn()
        .then(resolve, reject)
        .finally(() => {
          active -= 1;
          const next = waiting.shift();
          if (next) next();
        });
    };
    if (active < MAX_CONCURRENT) start();
    else waiting.push(start);
  });
}

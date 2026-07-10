import { toJpeg } from "html-to-image";

/**
 * Client-side "long screenshot" — render a DOM element to a high-DPI
 * JPEG and trigger a download. Powers the report 下載 JPG button.
 *
 * html-to-image clones the node and rasterises its FULL scroll size (not
 * just the viewport), so a tall report becomes one long image. All FB
 * CDN thumbnails inside must already be same-origin (see `proxyImage`)
 * or the capture taints and throws.
 */

/**
 * Resolve once the element's `<img>` count has held steady for
 * `stableMs` (or after `maxMs`). The report streams creative cards in
 * from async per-adset queries after first paint, so we can't capture
 * immediately — this waits for that stream to quiesce before the shot.
 */
export async function waitForStableDom(
  el: HTMLElement,
  { stableMs = 900, maxMs = 15000 }: { stableMs?: number; maxMs?: number } = {},
): Promise<void> {
  const start = Date.now();
  let lastCount = -1;
  let stableSince = Date.now();
  while (Date.now() - start < maxMs) {
    const count = el.querySelectorAll("img").length;
    if (count !== lastCount) {
      lastCount = count;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= stableMs) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Wait until every <img> inside `el` has finished loading (or errored)
 *  so the capture doesn't race ahead of half-decoded thumbnails. */
export async function waitForImages(el: HTMLElement): Promise<void> {
  const imgs = Array.from(el.querySelectorAll("img"));
  await Promise.all(
    imgs.map((img) =>
      img.complete && img.naturalWidth > 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
          }),
    ),
  );
}

/** Sanitise a campaign name / id into a safe file stem. */
function safeStem(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\n\r\t]+/g, "_").trim();
  return cleaned.slice(0, 80) || "report";
}

/**
 * Rasterise `el` to a JPEG at 2× device pixels and download it.
 * Waits for fonts + images first. Returns once the download has been
 * triggered; throws if the capture fails.
 */
export async function downloadElementAsJpeg(el: HTMLElement, fileStem: string): Promise<void> {
  if (typeof document !== "undefined" && document.fonts?.ready) {
    await document.fonts.ready;
  }
  await waitForImages(el);
  const dataUrl = await toJpeg(el, {
    pixelRatio: 2,
    quality: 0.95,
    backgroundColor: "#ffffff",
  });
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = `${safeStem(fileStem)}.jpg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

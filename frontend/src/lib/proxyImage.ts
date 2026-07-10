/**
 * Route an FB / IG CDN image URL through our same-origin
 * `/api/proxy-asset` endpoint so a client-side canvas capture
 * (html-to-image, used by the 下載 JPG flow) can inline the pixels
 * WITHOUT tainting the canvas.
 *
 * FB signed CDN URLs send no `Access-Control-Allow-Origin`, so a direct
 * cross-origin `<img>` taints any canvas it's drawn into and the JPEG
 * export throws / comes out blank. Serving the same bytes from our own
 * origin sidesteps CORS entirely.
 *
 * Only used in capture mode — normal report viewing keeps the raw CDN
 * URL so thumbnails load straight from Facebook's edge (fast, cached)
 * instead of round-tripping through our server.
 *
 * `data:` URLs and already-relative (same-origin) URLs pass through
 * untouched.
 */
export function proxyImage(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith("data:") || url.startsWith("/")) return url;
  return `/api/proxy-asset?url=${encodeURIComponent(url)}`;
}

import { useHiresThumbnail } from "@/api/hooks/useHiresThumbnail";
import { usePageInfo } from "@/api/hooks/usePageInfo";
import { usePostMedia } from "@/api/hooks/usePostMedia";
import { useVideoSource } from "@/api/hooks/useVideoSource";
import { Modal } from "@/components/Modal";
import { Spinner } from "@/components/Spinner";
import { fbPostLinkFromStoryId, isFrontPostCreative, pageIdFromStoryId } from "@/lib/fbLinks";
import type { FbCreativeEntity } from "@/types/fb";
import { useEffect, useState } from "react";

/**
 * Preview modal for a 3rd-level ad creative. Rendered from the
 * Dashboard tree (CreativeRow) whenever the user clicks an ad row.
 *
 * Two visual flavours — the layout branches on whether the ad is a
 * **front-stage post** (re-uses an existing organic FB/IG post) or a
 * **back-stage post** (authored inline in Ads Manager as a dark post).
 *
 *   ┌── Back-stage (內嵌廣告) ─────────────┐
 *   │ [avatar] Page name · 贊助 · Facebook │
 *   │                                      │
 *   │   [查看廣告貼文 →]  ← orange-outline  │  ← MOVED TO TOP
 *   │                                      │
 *   │   [image / video]                    │
 *   │   creative body text...              │
 *   └──────────────────────────────────────┘
 *
 *   ┌── Front-stage success (hi-res ok) ──┐
 *   │ [avatar] Page name · 贊助 · Facebook │
 *   │   [image / video]                    │
 *   │   creative body text...              │
 *   │   [在 Facebook 開啟原始貼文 ↗]        │
 *   └──────────────────────────────────────┘
 *
 *   ┌── Front-stage fallback (hi-res fail)┐
 *   │ [avatar] Page name · 贊助 · Facebook │
 *   │ ┌──────────────────────────────────┐│
 *   │ │  ▓▓ blurry 120px thumb ▓▓        ││
 *   │ │      [在 Facebook 查看原始貼文]   ││  ← semi-transparent
 *   │ │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ ││    black overlay
 *   │ └──────────────────────────────────┘│    + centered button
 *   │   creative body text...              │
 *   └──────────────────────────────────────┘
 *
 * Media fallback chain (front-stage only):
 *   1. usePostMedia  → full-res post image / playable video source
 *      (requires pages_read_engagement on the token — typically fails)
 *   2. useHiresThumbnail → 600px server-rendered thumbnail via the
 *      creative edge (reliably available, just softer)
 *   3. blurry thumbnail_url (~120px) + black overlay + CTA button
 */

export interface CreativePreviewModalProps {
  /** When non-null, the modal is open and shows this creative. */
  creative: FbCreativeEntity | null;
  /** Optional. When provided, the download button uses this as the
   *  filename root — typically the parent campaign's name so the
   *  saved file is identifiable when several ads share an account.
   *  Falls back to the creative's own name when omitted. */
  campaignName?: string;
  /** Media-only mode (報告 creative cards): show ONLY the media (video
   *  autoplays / image), with no page header, no download button, and
   *  no body text — just the content in a bare modal. */
  mediaOnly?: boolean;
  onClose: () => void;
}

/** Build a filesystem-safe filename for the downloaded asset. The
 *  creative name often contains `/`, `?`, etc. that the OS would
 *  reject, so we strip them and clamp the length. */
function buildDownloadName(creativeName: string, url: string, isVideo: boolean): string {
  const safe = (creativeName || "creative")
    .replace(/[\\/:*?"<>|\n\r\t]/g, "_")
    .slice(0, 80)
    .trim();
  const fallback = isVideo ? "mp4" : "jpg";
  let ext = fallback;
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.(mp4|mov|webm|m4v|jpg|jpeg|png|gif|webp)(?:$|\?)/i);
    if (m?.[1]) ext = m[1].toLowerCase();
  } catch {
    /* keep fallback */
  }
  return `${safe || "creative"}.${ext}`;
}

/** Map a filename extension to a MIME type. The blob from `fetch()`
 *  usually carries the right Content-Type, but FB's CDN occasionally
 *  returns an empty string and `navigator.share()` rejects File
 *  objects with no type — so we infer one from the extension as a
 *  belt-and-braces fallback. */
function mimeForExt(ext: string): string {
  const map: Record<string, string> = {
    mp4: "video/mp4",
    mov: "video/quicktime",
    m4v: "video/x-m4v",
    webm: "video/webm",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return map[ext.toLowerCase()] ?? "application/octet-stream";
}

/** Build the same-origin proxy URL for a remote FB/IG asset. Going
 *  through `/api/proxy-asset` on our own origin means:
 *    - the browser fetch is same-origin → blob() works
 *    - Content-Disposition: attachment forces save instead of
 *      iOS Safari's fullscreen video player (which has no save UI)
 *    - the resulting File can be fed into navigator.share() so the
 *      iOS share sheet shows "儲存影片 / 儲存到相簿". */
function proxyUrl(remoteUrl: string, filename: string): string {
  const u = new URLSearchParams({ url: remoteUrl, filename });
  return `/api/proxy-asset?${u.toString()}`;
}

/** Download a remote URL. On mobile (where the Web Share API
 *  reports `canShare({ files })`) we open the native share sheet so
 *  the user can pick "儲存到相簿 / 儲存到檔案" — iOS Safari ignores
 *  `<a download>` cross-origin and Android share sheets are the
 *  most reliable way to land the file in the user's gallery. On
 *  desktop we fall back to fetching the bytes and clicking a blob
 *  anchor (regular browser download). When everything fails we open
 *  the URL in a new tab so the user can right-click → save. */
async function downloadAsset(url: string, filename: string): Promise<void> {
  const proxied = proxyUrl(url, filename);
  try {
    const resp = await fetch(proxied, { credentials: "omit" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const ext = filename.split(".").pop() ?? "";
    const type =
      blob.type && blob.type !== "application/octet-stream" ? blob.type : mimeForExt(ext);
    const file = new File([blob], filename, { type });

    // Web Share API path — covers iOS Safari and modern Android
    // browsers. We probe with canShare(files) because share() may
    // exist on desktop Chrome without file support, in which case
    // we want the blob-anchor download instead.
    const nav = navigator as Navigator & {
      canShare?: (data: { files?: File[] }) => boolean;
      share?: (data: { files?: File[]; title?: string }) => Promise<void>;
    };
    if (nav.canShare?.({ files: [file] }) && typeof nav.share === "function") {
      try {
        await nav.share({ files: [file], title: filename });
        return;
      } catch (err) {
        // AbortError = the user dismissed the share sheet. Don't
        // fall through to the blob download, otherwise we'd queue
        // up a second save dialog they already declined.
        if (err instanceof Error && err.name === "AbortError") return;
        // Any other share error → fall through to blob anchor.
      }
    }

    // Desktop (and any platform without file share support): blob
    // anchor click. Defer the URL.revokeObjectURL so Safari has time
    // to spool the download before we tear the blob down.
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  } catch (err) {
    if (import.meta.env.DEV) {
      console.error("[creative] download failed, opening proxy URL", err);
    }
    // Last-resort: navigate the user to the proxy URL directly. The
    // backend sets Content-Disposition: attachment so even iOS
    // Safari treats it as a download instead of inline playback.
    window.location.assign(proxied);
  }
}

export function CreativePreviewModal({
  creative,
  campaignName,
  mediaOnly,
  onClose,
}: CreativePreviewModalProps) {
  const isOpen = creative !== null;
  const minimal = mediaOnly === true;
  // Video handle: back-stage inline video (object_story_spec.video_data)
  // OR Advantage+/dynamic creative (asset_feed_spec.videos[]). Modern ads
  // use the latter, so without it they'd fall back to a still image.
  const videoId =
    creative?.creative?.object_story_spec?.video_data?.video_id ??
    creative?.creative?.asset_feed_spec?.videos?.find((v) => v.video_id)?.video_id ??
    null;
  const videoQuery = useVideoSource(videoId, isOpen);

  // Track <img> load failures in the media block. For FB front-stage
  // posts, the chain often lands on `<img src={thumb}>` (the tiny
  // 120px thumbnail from the ad edge) — and FB commonly serves a
  // first-video-frame thumbnail for boosted video posts, which is
  // frequently BLACK (intro fade-in). Worse, the signed CDN URL
  // sometimes 403s when it expires mid-session. Either way, showing
  // a black box isn't helpful. When the img reports `onError`, we
  // switch to a text-only fallback that pushes the user to the
  // "view original post" CTA.
  //
  // The state resets whenever the modal opens for a different
  // creative so a past load failure doesn't shadow a different ad.
  const creativeId = creative?.creative?.id ?? creative?.id ?? null;
  const [imgError, setImgError] = useState(false);
  // Reset `imgError` whenever the modal opens for a different
  // creative so a previous load failure doesn't shadow the new ad.
  // biome's exhaustive-deps hint here is a warning we accept — the
  // effect is intentionally keyed on creativeId even though only
  // setImgError is read in the body.
  useEffect(() => {
    setImgError(false);
  }, [creativeId]);

  const storyId = creative?.creative?.effective_object_story_id;
  const pageId = pageIdFromStoryId(storyId);
  const pageQuery = usePageInfo(pageId, isOpen);

  const isFrontPost = creative?.creative ? isFrontPostCreative(creative.creative) : false;

  // Media fallback for front-stage posts — see file header.
  // 1. Try to read the underlying post directly
  const postMediaQuery = usePostMedia(storyId, isOpen && isFrontPost);
  const postImage = postMediaQuery.data?.image_url ?? null;
  const postVideoSource = postMediaQuery.data?.video_source ?? null;
  const postMediaResolved = !postMediaQuery.isLoading && !postMediaQuery.isPending;

  // 2. If post fetch resolved without a usable image/video, request
  //    the 600px creative-edge thumbnail as a fallback. This path
  //    doesn't need pages_read_engagement — it uses the same
  //    ads_read scope that the rest of the dashboard uses, so it
  //    almost always succeeds.
  const needsHires = isFrontPost && postMediaResolved && !postImage && !postVideoSource;
  const hiresQuery = useHiresThumbnail(creative?.creative?.id ?? null, isOpen && needsHires, 600);
  const hiresUrl = hiresQuery.data?.thumbnail_url ?? null;
  const hiresResolved = !needsHires || (!hiresQuery.isLoading && !hiresQuery.isPending);

  const thumb = creative?.creative?.thumbnail_url;
  // 3. Preview image priority: full-res post > 600px hires > inline
  //    image_url (back-stage only) > 120px row thumbnail (last resort)
  const previewImage = postImage ?? hiresUrl ?? creative?.creative?.image_url ?? thumb;
  const videoPoster = creative?.creative?.object_story_spec?.video_data?.image_url ?? previewImage;
  const creativeBody = creative?.creative?.body;

  // Carousel (輪播) ads: link_data.child_attachments holds one card per
  // slide. Each card is EITHER an image (`picture`, a display-size URL, far
  // sharper than the 120px row thumbnail) OR a video (`video_id` → resolve
  // a playable source per card, `picture` being its poster). child_attachments
  // is the RELIABLE carousel signal — asset_feed_spec.images can also hold
  // >1 entry but those are Advantage+ creative *variants* (FB picks one), not
  // carousel cards. A carousel takes precedence over the single image/hires
  // chain (but never over a single-video ad).
  const carouselCards = (creative?.creative?.object_story_spec?.link_data?.child_attachments ?? [])
    .map((c) => ({ picture: c.picture ?? null, videoId: c.video_id ?? null }))
    .filter((c) => c.picture || c.videoId);
  const isCarousel = !videoId && carouselCards.length > 1;

  // "View original post" URL resolution.
  //
  // We used to pass `instagram_permalink_url` straight through for
  // IG-sourced creatives, but the user reported getting Instagram's
  // "發生錯誤,無法載入頁面" error when clicking. That happens
  // whenever the underlying IG post is private / deleted / restricted
  // — IG returns the same generic error in all those cases, and
  // there's no way to verify the URL is live from the browser.
  //
  // Fix: prefer the **FB shadow-post URL** (derived from
  // `effective_object_story_id` via `fbPostLinkFromStoryId`). FB
  // internally creates a shadow post for every ad, including IG-
  // sourced ones, and those shadow posts:
  //   - are accessible using the user's already-logged-in FB session
  //     (the user is running the LURE dashboard, so they're signed
  //     into FB),
  //   - embed the original IG content for IG-sourced creatives, so
  //     the user sees the same material they expected,
  //   - keep working even if the IG source post has since been
  //     removed or made private.
  //
  // The IG permalink is still captured as `igPostUrl` for two
  // reasons: (1) it controls the header subtitle ("贊助 ·
  // Instagram" vs "贊助 · Facebook") so the user still sees where
  // the content originated, and (2) it's exposed as an optional
  // secondary text link so a user who explicitly wants the native
  // IG experience can click it.
  const igPostUrl = creative?.creative?.instagram_permalink_url ?? null;
  const fbPostUrl = fbPostLinkFromStoryId(storyId);
  const postUrl = fbPostUrl ?? igPostUrl;
  // postPlatform reflects the ORIGIN of the content (IG if the
  // creative exposed an instagram_permalink_url, otherwise FB),
  // NOT the URL we're actually linking to. This drives the header
  // subtitle so users see "贊助 · Instagram" for IG-sourced ads
  // even though the button opens the FB shadow post.
  const postPlatform: "Instagram" | "Facebook" | null = igPostUrl
    ? "Instagram"
    : fbPostUrl
      ? "Facebook"
      : null;

  // Front-stage: hi-res completely failed → fall back to the blurry
  // 120px thumb with a dark overlay + "view original" CTA so the
  // user still has something meaningful to click.
  const hiResFailed =
    isFrontPost &&
    postMediaResolved &&
    hiresResolved &&
    !postImage &&
    !postVideoSource &&
    !hiresUrl &&
    !!thumb;

  // Header display fields — prefer the real page name/avatar for FB
  // posts. For IG posts we can't pull the account name from the
  // Marketing API, so we show a generic "Instagram" label. For FB
  // posts where usePageInfo returned null (typically pages scope
  // missing) we still fall back to the ad name so the header never
  // reads blank.
  const headerName = pageQuery.data?.name ?? (igPostUrl ? "Instagram" : (creative?.name ?? ""));
  const headerAvatar = pageQuery.data?.picture_url ?? null;
  const headerSubtitle = postPlatform ? `贊助 · ${postPlatform}` : "贊助 · 廣告";

  // The "view post" CTA lives in the sticky header row via Modal's
  // titleAction slot. The label is now platform-neutral ("查看
  // 廣告貼文") because the link always goes to the FB shadow post
  // regardless of content origin — see the `postUrl` resolution
  // comment above. The header subtitle still tells the user where
  // the content is originally from ("贊助 · Instagram" etc.).
  // The hi-res-failed case has its own on-image CTA, so we skip
  // the header button there to avoid a duplicate call-to-action.
  const showHeaderPostButton = postUrl && !hiResFailed;
  const headerPostButton = showHeaderPostButton ? (
    <a
      href={postUrl ?? undefined}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 rounded-pill border-[1.5px] border-orange bg-white px-3 py-1 text-[12px] font-semibold text-orange transition hover:bg-orange-bg active:scale-[0.98]"
    >
      查看廣告貼文
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <polyline points="15 3 21 3 21 9" />
        <line x1="10" y1="14" x2="21" y2="3" />
      </svg>
    </a>
  ) : null;

  return (
    <Modal
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={
        minimal ? undefined : (
          <div className="flex min-w-0 items-center gap-2.5">
            {headerAvatar ? (
              <img
                src={headerAvatar}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-10 w-10 shrink-0 rounded-full border border-border object-cover"
              />
            ) : igPostUrl ? (
              // Instagram fallback avatar — generic IG camera glyph
              // on a subtle gradient so IG-sourced creatives still get
              // a recognisable header.
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#FEDA77] via-[#F58529] to-[#DD2A7B] text-white">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="2" y="2" width="20" height="20" rx="5" />
                  <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
                  <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
                </svg>
              </div>
            ) : (
              <div className="h-10 w-10 shrink-0 rounded-full bg-bg" />
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-semibold leading-tight text-ink">
                {headerName}
              </div>
              <div className="text-[11px] font-normal text-gray-300">{headerSubtitle}</div>
            </div>
          </div>
        )
      }
      titleAction={minimal ? undefined : headerPostButton}
      width={520}
    >
      {creative &&
        (minimal ? (
          // 報告 creative card: bare media only — no header, download, or
          // body. Video autoplays; image just shows. Carousels show the
          // multi-card strip.
          isCarousel ? (
            <CarouselBlock cards={carouselCards} creativeName={creative.name} />
          ) : (
            <MediaBlock
              creativeName={creative.name}
              videoId={videoId}
              videoQueryLoading={videoQuery.isLoading || videoQuery.isPending}
              videoSource={videoQuery.data?.source ?? null}
              videoPicture={videoQuery.data?.picture ?? null}
              videoPoster={videoPoster ?? null}
              isFrontPost={isFrontPost}
              postMediaLoading={postMediaQuery.isLoading || postMediaQuery.isPending}
              hiresLoading={hiresQuery.isLoading || hiresQuery.isFetching}
              needsHires={needsHires}
              postVideoSource={postVideoSource}
              previewImage={previewImage ?? null}
              hiResFailed={hiResFailed}
              thumb={thumb ?? null}
              imgError={imgError}
              onImgError={() => setImgError(true)}
              postUrl={postUrl}
            />
          )
        ) : (
          <div className="flex flex-col gap-3">
            {isCarousel ? (
              <CarouselBlock cards={carouselCards} creativeName={creative.name} />
            ) : (
              <MediaBlock
                creativeName={creative.name}
                videoId={videoId}
                videoQueryLoading={videoQuery.isLoading || videoQuery.isPending}
                videoSource={videoQuery.data?.source ?? null}
                videoPicture={videoQuery.data?.picture ?? null}
                videoPoster={videoPoster ?? null}
                isFrontPost={isFrontPost}
                postMediaLoading={postMediaQuery.isLoading || postMediaQuery.isPending}
                hiresLoading={hiresQuery.isLoading || hiresQuery.isFetching}
                needsHires={needsHires}
                postVideoSource={postVideoSource}
                previewImage={previewImage ?? null}
                hiResFailed={hiResFailed}
                thumb={thumb ?? null}
                imgError={imgError}
                onImgError={() => setImgError(true)}
                postUrl={postUrl}
              />
            )}

            <DownloadAssetButton
              creativeName={campaignName?.trim() || creative.name}
              videoSource={videoQuery.data?.source ?? null}
              postVideoSource={postVideoSource}
              previewImage={
                (isCarousel ? (carouselCards[0]?.picture ?? null) : previewImage) ?? null
              }
            />

            {creativeBody && (
              <p className="w-full whitespace-pre-wrap text-[13px] leading-relaxed text-ink">
                {creativeBody}
              </p>
            )}
          </div>
        ))}
    </Modal>
  );
}

/**
 * Internal helper that renders just the image / video block of the
 * preview modal. Kept as a named function (not an IIFE) so biome's
 * useMediaCaption suppression comment can sit directly adjacent to
 * the `<video>` JSX element — biome doesn't attach suppressions that
 * cross a `return (` boundary inside an IIFE.
 *
 * Decision order:
 *   1. Inline-authored video (we have a video_id + resolved source)
 *   2. Front-stage: post-media OR hires-thumbnail still loading
 *   3. Front-stage video post (underlying post exposed a source)
 *   4. Front-stage hi-res FAILED — blurry thumb + dark overlay + CTA
 *   5. Any still image — postImage > hiresUrl > inline image_url > thumb
 *   6. Fallback "無預覽素材" placeholder
 */
interface MediaBlockProps {
  creativeName: string;
  videoId: string | null;
  videoQueryLoading: boolean;
  videoSource: string | null;
  videoPicture: string | null;
  videoPoster: string | null;
  isFrontPost: boolean;
  postMediaLoading: boolean;
  hiresLoading: boolean;
  needsHires: boolean;
  postVideoSource: string | null;
  previewImage: string | null;
  hiResFailed: boolean;
  thumb: string | null;
  /** True once a child `<img>` has reported onError — switches the
   * render to a text-only fallback. Parent resets this state when
   * a different creative is opened. */
  imgError: boolean;
  onImgError: () => void;
  postUrl: string | null;
}

function MediaBlock(props: MediaBlockProps) {
  const {
    creativeName,
    videoId,
    videoQueryLoading,
    videoSource,
    videoPicture,
    videoPoster,
    isFrontPost,
    postMediaLoading,
    hiresLoading,
    needsHires,
    postVideoSource,
    previewImage,
    hiResFailed,
    thumb,
    imgError,
    onImgError,
    postUrl,
  } = props;

  // Shared text-only fallback for "we tried, image didn't load,
  // go see the real thing". Used in two places:
  //   1. Front-stage post whose `<img>` reported onError — most
  //      commonly a FB boosted-video post where FB's thumbnail_url
  //      renders as a black first-frame or returns 403 on an
  //      expired signed CDN URL.
  //   2. Last-resort placeholder when the entire fallback chain
  //      yielded no usable media at all.
  const renderTextFallback = (message: string) => (
    <div className="flex min-h-[240px] w-full flex-col items-center justify-center gap-3 rounded-lg border border-border bg-bg px-6 text-center">
      <svg
        width="32"
        height="32"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-gray-300"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
      <div className="text-[13px] leading-relaxed text-gray-500">{message}</div>
      {postUrl && (
        <a
          href={postUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-flex items-center gap-1.5 rounded-pill border-[1.5px] border-orange bg-white px-4 py-1.5 text-[12px] font-semibold text-orange transition hover:bg-orange-bg active:scale-[0.98]"
        >
          查看廣告貼文
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </a>
      )}
    </div>
  );

  if (videoId) {
    if (videoQueryLoading) {
      return (
        <div className="flex min-h-[240px] w-full items-center justify-center rounded-lg border border-border bg-bg">
          <Spinner size={24} />
        </div>
      );
    }
    if (videoSource) {
      return (
        // biome-ignore lint/a11y/useMediaCaption: FB ad videos have no caption track available via the Graph API.
        <video
          controls
          autoPlay
          playsInline
          src={videoSource}
          poster={videoPicture ?? videoPoster ?? undefined}
          className="max-h-[70vh] w-full rounded-lg border border-border bg-black"
        >
          您的瀏覽器不支援 HTML5 video。
        </video>
      );
    }
    if (imgError) {
      return renderTextFallback("無法載入預覽");
    }
    return (
      <img
        src={videoPoster ?? ""}
        alt={creativeName}
        loading="lazy"
        decoding="async"
        onError={onImgError}
        className="max-h-[70vh] w-full rounded-lg border border-border object-contain"
      />
    );
  }

  // Front-stage post still resolving — show a spinner while either
  // the post-media OR the hires-thumbnail fallback query is in flight.
  if (isFrontPost && (postMediaLoading || (needsHires && hiresLoading))) {
    return (
      <div className="flex min-h-[240px] w-full items-center justify-center rounded-lg border border-border bg-bg">
        <Spinner size={24} />
      </div>
    );
  }

  if (postVideoSource) {
    return (
      // biome-ignore lint/a11y/useMediaCaption: FB ad videos have no caption track available via the Graph API.
      <video
        controls
        autoPlay
        playsInline
        src={postVideoSource}
        poster={previewImage ?? videoPoster ?? undefined}
        className="max-h-[70vh] w-full rounded-lg border border-border bg-black"
      >
        您的瀏覽器不支援 HTML5 video。
      </video>
    );
  }

  // Image load previously failed — skip straight to the text
  // fallback instead of re-rendering the broken image. Without
  // this, `<img onError>` would fire, we'd set state, then re-
  // render the img tag pointing at the same URL, which would
  // fire onError again in an endless loop on some browsers.
  if (imgError && isFrontPost) {
    return renderTextFallback(
      "這則廣告是前台貼文,預覽圖在此無法載入。點下方按鈕查看廣告貼文原圖或影片。",
    );
  }

  // Front-stage post, both hi-res paths exhausted, but we still
  // have the tiny 120px row icon. Render it filling the modal
  // with a soft warm-white bg (NOT black — broken images on a
  // black background look totally broken) and a blur so the
  // pixelation reads as intentional. The CTA overlay points the
  // user to the FB shadow post for the real thing.
  if (hiResFailed && thumb && postUrl) {
    return (
      <div className="relative w-full overflow-hidden rounded-lg border border-border bg-bg">
        <img
          src={thumb}
          alt={creativeName}
          loading="lazy"
          decoding="async"
          onError={onImgError}
          // filter: blur softens the pixelation from stretching 120px
          // to 520px so the overlay still looks intentional.
          className="block max-h-[70vh] w-full object-contain blur-[1.5px]"
        />
        <div className="absolute inset-0 flex items-center justify-center bg-black/35">
          <a
            href={postUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-pill bg-white/95 px-4 py-2 text-[13px] font-semibold text-ink shadow-md backdrop-blur hover:bg-white active:scale-[0.98]"
          >
            查看廣告貼文
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
              <polyline points="15 3 21 3 21 9" />
              <line x1="10" y1="14" x2="21" y2="3" />
            </svg>
          </a>
        </div>
      </div>
    );
  }

  if (previewImage) {
    return (
      <img
        src={previewImage}
        alt={creativeName}
        loading="lazy"
        decoding="async"
        onError={onImgError}
        className="max-h-[70vh] w-full rounded-lg border border-border object-contain"
      />
    );
  }

  return (
    <div className="flex min-h-[200px] w-full items-center justify-center rounded-lg border border-border bg-bg text-xs text-gray-300">
      無預覽素材
    </div>
  );
}

interface CarouselCardData {
  picture: string | null;
  videoId: string | null;
}

/**
 * Carousel (輪播) ad — horizontal scroll-snap strip of the cards. Each
 * card is an image (`picture`, display-size) OR a video (`videoId`, which
 * we resolve to a playable source). A count chip tells the user how many
 * cards there are.
 */
function CarouselBlock({
  cards,
  creativeName,
}: {
  cards: CarouselCardData[];
  creativeName: string;
}) {
  return (
    <div className="relative">
      <div className="absolute right-2 top-2 z-[1] rounded-pill bg-black/55 px-2 py-0.5 text-[11px] font-semibold text-white">
        輪播 · {cards.length} 張
      </div>
      <div className="flex snap-x snap-mandatory gap-2 overflow-x-auto rounded-lg [scrollbar-width:thin]">
        {cards.map((card, i) => (
          <CarouselCard
            key={card.videoId ?? card.picture ?? i}
            card={card}
            label={`${creativeName} - ${i + 1}`}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One carousel card. When the card carries a `videoId` we resolve a
 * playable source (poster = its `picture`) and render a `<video>`; while
 * that resolves — or if it fails / the viewer isn't authed — we fall back
 * to the poster image. A dead image URL hides just this card.
 */
function CarouselCard({ card, label }: { card: CarouselCardData; label: string }) {
  const [broken, setBroken] = useState(false);
  const vid = useVideoSource(card.videoId, !!card.videoId);
  const videoSource = vid.data?.source ?? null;
  const poster = vid.data?.picture ?? card.picture ?? null;
  const cls =
    "max-h-[70vh] w-[86%] shrink-0 snap-center rounded-lg border border-border object-contain last:mr-0";

  if (card.videoId) {
    if (vid.isLoading || vid.isPending) {
      return (
        <div
          className={`flex ${cls.replace("object-contain", "")} min-h-[240px] items-center justify-center bg-bg`}
        >
          <Spinner size={22} />
        </div>
      );
    }
    if (videoSource) {
      return (
        // biome-ignore lint/a11y/useMediaCaption: FB ad videos have no caption track available via the Graph API.
        <video
          controls
          playsInline
          src={videoSource}
          poster={poster ?? undefined}
          className={`${cls} bg-black`}
        >
          您的瀏覽器不支援 HTML5 video。
        </video>
      );
    }
    // Video source unavailable (not authed / resolve failed) → poster.
  }

  if (poster && !broken) {
    return (
      <img
        src={poster}
        alt={label}
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
        className={cls}
      />
    );
  }
  return (
    <div
      className={`flex ${cls} min-h-[200px] items-center justify-center bg-bg text-xs text-gray-300`}
    >
      無法載入
    </div>
  );
}

/** Pill button under the media block that downloads the underlying
 *  asset (video preferred, image fallback). Hidden when neither has
 *  resolved yet. The fetched bytes are saved via blob anchor so FB
 *  CDN URLs save instead of navigating. */
function DownloadAssetButton({
  creativeName,
  videoSource,
  postVideoSource,
  previewImage,
}: {
  creativeName: string;
  videoSource: string | null;
  postVideoSource: string | null;
  previewImage: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const downloadUrl = videoSource ?? postVideoSource ?? previewImage;
  const isVideo = !!(videoSource || postVideoSource);

  if (!downloadUrl) return null;

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await downloadAsset(downloadUrl, buildDownloadName(creativeName, downloadUrl, isVideo));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex">
      <button
        type="button"
        onClick={() => void onClick()}
        disabled={busy}
        className="inline-flex items-center gap-1.5 rounded-pill border-[1.5px] border-orange bg-white px-3 py-1.5 text-[12px] font-semibold text-orange transition hover:bg-orange-bg active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
      >
        {busy ? (
          <Spinner size={14} />
        ) : (
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        )}
        {busy ? "下載中..." : isVideo ? "下載影片" : "下載圖片"}
      </button>
    </div>
  );
}

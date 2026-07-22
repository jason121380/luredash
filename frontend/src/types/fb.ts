/**
 * Facebook Marketing API response shapes.
 *
 * Handwritten for now — Phase 1 runs before Phase 0's openapi codegen
 * wires up `pnpm gen:api`. Once that exists, these types will be
 * replaced by generated ones from `schema.d.ts`.
 *
 * Kept minimal: only the fields the UI actually reads, and only the
 * field names documented in CLAUDE.md / MEMORY.md.
 */

export interface FbAction {
  action_type: string;
  value: string; // FB returns all numbers as strings
}

export interface FbInsights {
  spend?: string;
  impressions?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  reach?: string;
  frequency?: string;
  actions?: FbAction[];
  inline_link_clicks?: string;
  cost_per_inline_link_click?: string;
  cost_per_action_type?: FbAction[];
  purchase_roas?: FbAction[];
  website_purchase_roas?: FbAction[];
  /** Avg seconds the video was watched. Present only for video
   *  creatives; the value lives in the first entry's `value`. */
  video_avg_time_watched_actions?: FbAction[];
  /** 完整播放(100%)次數 — video creatives only. */
  video_p100_watched_actions?: FbAction[];
  /** ThruPlay(≥15 秒或看完)次數 — video creatives only. */
  video_thruplay_watched_actions?: FbAction[];
  /** 影片播放次數 — video creatives only. Denominator for 完整播放率. */
  video_play_actions?: FbAction[];
}

export interface FbInsightsEnvelope {
  data?: FbInsights[];
}

export type FbEntityStatus = "ACTIVE" | "PAUSED" | "ARCHIVED" | "DELETED" | string;

export interface FbBaseEntity {
  id: string;
  name: string;
  status: FbEntityStatus;
  effective_status?: FbEntityStatus;
  configured_status?: FbEntityStatus;
  insights?: FbInsightsEnvelope;
}

export interface FbCampaign extends FbBaseEntity {
  objective?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  // ISO 8601 timestamps from FB ("2026-05-22T15:30:00+0000"). created_time
  // is used by 安全監控 to group by creation day; updated_time is used by
  // the LINE flex push to render "M/D 已暫停".
  created_time?: string;
  updated_time?: string;
  // Nested adset budgets — populated when the backend asks for
  // `adsets{daily_budget,lifetime_budget,status}`. Used by 安全監控 to
  // compute an "effective" daily budget when the campaign uses ABO
  // (per-adset budgets) instead of CBO (campaign-level budget).
  adsets?: {
    data?: Array<{
      daily_budget?: string;
      lifetime_budget?: string;
      status?: FbEntityStatus;
    }>;
  };
  // injected client-side during normalization so we can render the
  // account name on multi-account rows
  _accountId?: string;
  _accountName?: string;
  /** Team-wide 店家 · 設計師 nickname, resolved server-side on
   *  `GET /api/campaigns/{id}` (share page). Absent on dashboard rows;
   *  the report falls back to the cached `useNicknames()` map there. */
  nickname?: string;
}

/** One row from FB Activity Log (`act_X/activities`). The `extra_data`
 * field is a JSON-encoded string whose shape FB does not document;
 * the security view treats it as opaque text. */
export interface FbActivity {
  actor_id?: string;
  actor_name?: string;
  event_time?: string;
  event_type?: string;
  translated_event_type?: string;
  object_id?: string;
  object_name?: string;
  object_type?: string;
  extra_data?: string;
}

export interface FbAdset extends FbBaseEntity {
  daily_budget?: string;
  lifetime_budget?: string;
}

export interface FbVideoData {
  /** FB video asset id. Resolve via the Graph API `/{video_id}`
   * edge to fetch the playable `source` URL and `picture` poster. */
  video_id?: string;
  /** Video poster / still image URL. */
  image_url?: string;
  title?: string;
  message?: string;
}

/** One card of a carousel ad (`link_data.child_attachments[]`). `picture`
 * is a display-size image URL (much larger than the 120px row thumbnail). */
export interface FbChildAttachment {
  picture?: string;
  image_hash?: string;
  /** Present when this carousel card is a video — resolve a playable
   * source via `useVideoSource`; `picture` is then the poster frame. */
  video_id?: string;
  link?: string;
  name?: string;
  description?: string;
}

export interface FbLinkData {
  message?: string;
  name?: string;
  description?: string;
  /** Single-card image URL (non-carousel link ads). */
  picture?: string;
  /** Present on CAROUSEL ads — one entry per card. */
  child_attachments?: FbChildAttachment[];
}

export interface FbObjectStorySpec {
  video_data?: FbVideoData;
  /** Present when the creative was authored inline as an image/link ad in
   * Ads Manager. `child_attachments` carries the carousel cards; a bare
   * `link_data` (no children) is a single-image dark post. Presence alone
   * still classifies inline-authored dark posts vs front-stage posts. */
  link_data?: FbLinkData;
  photo_data?: Record<string, unknown>;
  template_data?: Record<string, unknown>;
}

export interface FbCreative {
  /** FB AdCreative node id. Requested so the frontend can hit
   * /api/creatives/{id}/hires-thumbnail for a 600px fallback when
   * /api/posts/{post_id}/media can't read the underlying page post
   * (typically because the token lacks pages_read_engagement). */
  id?: string;
  /** Small (~64-600px) thumbnail URL — used for the 30x30 row icon. */
  thumbnail_url?: string;
  /** Full-resolution source asset URL (typically 1080px+) — used by
   * the preview modal so enlarging it doesn't produce a blurry image.
   * Absent on non-image creatives (video, carousel, DPA) — fall back
   * to thumbnail_url in that case. */
  image_url?: string;
  /** Nested story spec — when the ad is a video, `video_data.video_id`
   * is the handle used to fetch the playable source. */
  object_story_spec?: FbObjectStorySpec;
  /** Advantage+ / dynamic creative spec. Modern video ads keep their
   * video here (`asset_feed_spec.videos[].video_id`) instead of in
   * object_story_spec.video_data — needed so those ads play instead of
   * showing a still image. */
  asset_feed_spec?: {
    videos?: Array<{ video_id?: string; thumbnail_url?: string }>;
    images?: Array<{ url?: string }>;
  };
  /** FB post id in the form `{pageId}_{postId}`. When the creative
   * is built from an existing FB post, resolving this via
   * `fbPostLinkFromStoryId` gives us a direct permalink so users can
   * view the full-resolution original on Facebook (the Marketing API
   * thumbnails are already compressed). */
  effective_object_story_id?: string;
  /** IG permalink — present when the creative is built from an IG
   * post. Directly openable; no resolving needed. */
  instagram_permalink_url?: string;
  title?: string;
  body?: string;
}

/** FB calls it an "Ad", but we use "Creative" throughout the UI
 * and class names to avoid matching any ad blocker filter that
 * targets `ad-*`. See commit d720fa2. */
export interface FbCreativeEntity extends FbBaseEntity {
  creative?: FbCreative;
}

export interface FbBusiness {
  id: string;
  name: string;
}

export interface FbAccount {
  id: string; // "act_123456"
  name: string;
  account_status: number;
  currency?: string;
  timezone_name?: string;
  business?: FbBusiness;
}

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
}

export interface FbInsightsEnvelope {
  data?: FbInsights[];
}

export type FbEntityStatus = "ACTIVE" | "PAUSED" | "ARCHIVED" | "DELETED" | string;

export interface FbBaseEntity {
  id: string;
  name: string;
  status: FbEntityStatus;
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
  // injected client-side during normalization so we can render the
  // account name on multi-account rows
  _accountId?: string;
  _accountName?: string;
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

export interface FbObjectStorySpec {
  video_data?: FbVideoData;
  /** Present when the creative was authored inline as an image ad in
   * Ads Manager. Opaque shape — we only check presence to tell
   * inline-authored dark posts apart from front-stage boosted posts. */
  link_data?: Record<string, unknown>;
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

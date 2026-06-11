/**
 * Build deep links into Facebook Ads Manager for a given entity.
 *
 * The legacy the original design and the AlertCard view both compose
 * these URLs; centralising them here means we have ONE implementation
 * to keep in sync with FB's URL schema.
 *
 * Required: account id (with or without `act_` prefix). Optional:
 * business id — without it FB still opens the campaign but may
 * land you in the wrong Business Manager workspace.
 */

function stripActPrefix(accountId: string | undefined): string {
  if (!accountId) return "";
  return accountId.startsWith("act_") ? accountId.slice(4) : accountId;
}

/**
 * Deep link to a single campaign in the Ads Manager edit drawer.
 */
export function fbCampaignLink(
  campaignId: string,
  accountId: string | undefined,
  businessId?: string,
): string {
  const act = stripActPrefix(accountId);
  if (!act) return "";
  const bizParam = businessId ? `&business_id=${businessId}` : "";
  return `https://adsmanager.facebook.com/adsmanager/manage/campaigns/edit/standalone?act=${act}${bizParam}&selected_campaign_ids=${campaignId}&current_step=0`;
}

/**
 * Construct a public Facebook post permalink from the creative's
 * `effective_object_story_id`, which FB returns as `{pageId}_{postId}`.
 *
 * Used by the creative preview modal so users can jump to the
 * original FB post to see the full-resolution image / video — the
 * Marketing API thumbnails are compressed front-facing previews and
 * there's no API to get the underlying asset at higher quality.
 *
 * Returns null if the input is undefined, empty, or doesn't match
 * the expected `pageId_postId` shape. Callers should use this null
 * return to decide whether to render the "在 Facebook 開啟原始貼文"
 * link at all.
 */
/**
 * Pull the page id out of `effective_object_story_id` =
 * `"{pageId}_{postId}"`. Returns null when the input is missing or
 * doesn't have the expected shape. Shared by the dashboard 3rd-level
 * page chip and the creative preview modal header.
 */
export function pageIdFromStoryId(storyId: string | undefined): string | null {
  if (!storyId) return null;
  const i = storyId.indexOf("_");
  if (i <= 0) return null;
  return storyId.slice(0, i);
}

export function fbPostLinkFromStoryId(storyId: string | undefined): string | null {
  if (!storyId) return null;
  const underscoreAt = storyId.indexOf("_");
  if (underscoreAt <= 0 || underscoreAt === storyId.length - 1) return null;
  const pageId = storyId.slice(0, underscoreAt);
  const postId = storyId.slice(underscoreAt + 1);
  return `https://www.facebook.com/${pageId}/posts/${postId}`;
}

/**
 * Is this creative built from an existing organic FB/IG post (as
 * opposed to assets authored inside Ads Manager)?
 *
 * IMPORTANT — why this is NOT just
 * `!!creative.effective_object_story_id`: Facebook returns
 * `effective_object_story_id` for EVERY ad, even ones authored
 * inline in Ads Manager. When you build an image/video ad via
 * `object_story_spec`, FB internally creates a "dark post" for it
 * and exposes that dark post id through `effective_object_story_id`.
 * So using that field alone flags 100% of creatives as front-stage
 * posts (the bug the user reported on 2026-04-14).
 *
 * Correct detection: a creative is a **front-stage post** (reuses an
 * existing organic FB/IG post) only when it does NOT have inline
 * creative content in `object_story_spec`. If `object_story_spec`
 * is populated with `link_data` / `video_data` / `photo_data` /
 * `template_data`, the ad was authored inline (dark post created
 * by Ads Manager) — so it's NOT a front-stage post, regardless of
 * what `effective_object_story_id` says.
 *
 * For IG-sourced ads, `instagram_permalink_url` is a strong signal
 * that the creative reuses an organic IG post — Ads-Manager-inline
 * ads don't get an IG permalink.
 *
 * Used by the Dashboard tree to show a "前台貼文" badge on rows
 * that re-use an existing post.
 */
export function isFrontPostCreative(creative: {
  object_story_spec?: {
    link_data?: unknown;
    video_data?: unknown;
    photo_data?: unknown;
    template_data?: unknown;
  };
  effective_object_story_id?: string;
  instagram_permalink_url?: string;
}): boolean {
  const spec = creative.object_story_spec;
  const hasInlineContent = Boolean(
    spec && (spec.link_data || spec.video_data || spec.photo_data || spec.template_data),
  );
  if (hasInlineContent) return false;
  // IG permalink OR a bare effective_object_story_id (with no
  // inline spec content) ⇒ the ad reuses an existing organic post.
  return Boolean(creative.effective_object_story_id || creative.instagram_permalink_url);
}

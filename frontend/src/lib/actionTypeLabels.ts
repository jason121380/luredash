/**
 * FB `action_type` → 中文 對照。用於工程模式 action_type 探針的中英對照
 * 表。只涵蓋常見/會出現在本平台廣告的類型;未收錄的回空字串(表格顯示
 * 「—」),原始 code 仍會並列。
 */
const ACTION_TYPE_LABELS: Record<string, string> = {
  // 點擊 / 連結
  link_click: "連結點擊",
  landing_page_view: "到達網頁瀏覽",
  outbound_click: "外連點擊",
  // 私訊
  "onsite_conversion.messaging_conversation_started_7d": "開啟私訊對話數(7天)",
  "onsite_conversion.messaging_conversation_replied_7d": "已回覆私訊對話數(7天)",
  "onsite_conversion.messaging_first_reply": "首次私訊回覆數",
  "onsite_conversion.messaging_block": "私訊被封鎖數",
  "onsite_conversion.messaging_user_depth_2_message_send": "私訊對話深度達 2 則",
  "onsite_conversion.messaging_user_depth_3_message_send": "私訊對話深度達 3 則",
  "onsite_conversion.total_messaging_connection": "私訊總連結數(勿用來算私訊,會重複計)",
  // 貼文互動
  post: "分享數",
  post_reaction: "貼文心情/按讚數",
  comment: "留言數",
  "onsite_conversion.post_save": "貼文收藏數",
  "onsite_conversion.post_net_save": "貼文淨收藏(收藏－取消)",
  "onsite_conversion.post_net_like": "貼文淨按讚(讚－退讚)",
  "onsite_conversion.post_unlike": "貼文退讚數",
  post_engagement: "貼文互動總數",
  page_engagement: "粉絲專頁互動總數",
  post_interaction_gross: "貼文互動(總)",
  post_interaction_net: "貼文互動(淨)",
  like: "粉絲專頁按讚",
  photo_view: "相片瀏覽",
  // 影片
  video_view: "影片觀看次數(3 秒)",
  // 轉換
  purchase: "購買",
  omni_purchase: "購買(全通路)",
  "offsite_conversion.fb_pixel_purchase": "購買(Pixel)",
  add_to_cart: "加入購物車",
  omni_add_to_cart: "加入購物車(全通路)",
  lead: "名單",
  "onsite_conversion.lead_grouped": "名單(合計)",
};

/** 回傳 action_type 的中文;未收錄回空字串。 */
export function actionTypeLabel(code: string): string {
  return ACTION_TYPE_LABELS[code] ?? "";
}

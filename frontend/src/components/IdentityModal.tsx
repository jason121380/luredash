import { useFbAuth } from "@/auth/FbAuthProvider";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/Toast";

/**
 * 登入身分 — shows the logged-in Facebook user's name + fb_user_id with a
 * 1-tap copy button. Opened by tapping the avatar in the sidebar footer
 * (moved out of 工程模式 so non-engineers can grab their id for support).
 */
export function IdentityModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { user } = useFbAuth();
  const id = user?.id ?? "";

  const onCopy = async () => {
    if (!id) return;
    try {
      await navigator.clipboard.writeText(id);
      toast("已複製 fb_user_id");
    } catch {
      toast("複製失敗,請手動選取", "error");
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="登入身分"
      subtitle="目前登入的 Facebook 使用者 id"
      width={380}
    >
      <div className="flex items-center gap-3">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-full bg-orange-bg text-[16px] font-bold text-orange">
          {user?.pictureUrl ? (
            <img
              src={user.pictureUrl}
              alt=""
              loading="lazy"
              decoding="async"
              className="h-full w-full object-cover"
            />
          ) : (
            (user?.name?.[0] ?? "?").toUpperCase()
          )}
        </div>
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold text-ink">
            {user?.name ?? "(未登入)"}
          </div>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-[12px]">
        <dt className="text-gray-400">fb_user_id</dt>
        <dd className="break-all font-mono text-ink">{id || "(未登入)"}</dd>
      </dl>

      <div className="mt-4">
        <Button size="sm" onClick={onCopy} disabled={!id}>
          複製 fb_user_id
        </Button>
      </div>
    </Modal>
  );
}

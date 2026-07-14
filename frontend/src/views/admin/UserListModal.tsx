import { type AdminUser, api, friendlyApiError } from "@/api/client";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/Toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const TIER_LABEL: Record<string, string> = {
  free: "免費",
  basic: "基本",
  plus: "進階",
  max: "旗艦",
};

/**
 * 用戶列表 (admin only) — every user who has logged in, with their tier
 * and role. Admins can grant / revoke admin (權限) here; the two seed
 * admins are protected from change.
 */
export function UserListModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => api.admin.listUsers(),
    enabled: open,
    staleTime: 30_000,
  });
  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: string; role: "admin" | "user" }) =>
      api.admin.setUserRole(id, role),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["admin", "whoami"] });
      toast("已更新權限", "success", 2000);
    },
    onError: (e) => toast(`更新失敗:${friendlyApiError(e)}`, "error", 4000),
  });

  const rows = q.data?.data ?? [];
  const defaults = new Set(q.data?.default_admin_ids ?? []);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="用戶列表"
      subtitle={q.data ? `共 ${rows.length} 位登入過的用戶` : "所有登入過的用戶"}
      width={780}
      className="md:h-[calc(100dvh-48px)] md:max-h-[calc(100dvh-48px)]"
    >
      {q.isLoading ? (
        <div className="px-1 py-10 text-center text-[13px] text-gray-300">載入中...</div>
      ) : q.isError ? (
        <div className="px-1 py-10 text-center text-[13px] text-red">
          載入失敗:{q.error instanceof Error ? q.error.message : "未知錯誤"}
        </div>
      ) : rows.length === 0 ? (
        <div className="px-1 py-10 text-center text-[13px] text-gray-300">尚無用戶</div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-border border-b bg-bg text-left text-[11px] font-semibold uppercase tracking-[0.5px] text-gray-400">
                <th className="px-3 py-2">用戶</th>
                <th className="px-3 py-2">fb_user_id</th>
                <th className="px-3 py-2">方案</th>
                <th className="px-3 py-2">權限</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => (
                <UserRow
                  key={u.fb_user_id}
                  user={u}
                  isDefaultAdmin={defaults.has(u.fb_user_id)}
                  busy={setRole.isPending}
                  onRole={(role) => setRole.mutate({ id: u.fb_user_id, role })}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function UserRow({
  user,
  isDefaultAdmin,
  busy,
  onRole,
}: {
  user: AdminUser;
  isDefaultAdmin: boolean;
  busy: boolean;
  onRole: (role: "admin" | "user") => void;
}) {
  return (
    <tr className="border-border border-b last:border-0">
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-full bg-orange-bg text-[11px] font-bold text-orange">
            {user.picture_url ? (
              <img
                src={user.picture_url}
                alt=""
                loading="lazy"
                decoding="async"
                className="h-full w-full object-cover"
              />
            ) : (
              (user.name?.[0] ?? "?").toUpperCase()
            )}
          </div>
          <span className="truncate font-semibold text-ink">{user.name || "(未知)"}</span>
        </div>
      </td>
      <td className="px-3 py-2 font-mono text-[11px] text-gray-500">{user.fb_user_id}</td>
      <td className="px-3 py-2 text-gray-500">{TIER_LABEL[user.tier] ?? user.tier}</td>
      <td className="px-3 py-2">
        {isDefaultAdmin ? (
          <span className="rounded-full border border-orange bg-orange-bg px-2 py-[2px] text-[11px] font-semibold text-orange">
            管理員(預設)
          </span>
        ) : (
          <select
            value={user.role}
            disabled={busy}
            onChange={(e) => onRole(e.currentTarget.value as "admin" | "user")}
            className="h-[28px] rounded-md border border-border bg-white px-2 text-[12px] disabled:opacity-50"
          >
            <option value="user">一般用戶</option>
            <option value="admin">管理員</option>
          </select>
        )}
      </td>
    </tr>
  );
}

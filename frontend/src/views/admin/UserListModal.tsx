import { type AdminUser, api, friendlyApiError } from "@/api/client";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/Toast";
import { ALL_PAGE_KEYS, GATED_PAGES } from "@/lib/pagePerms";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

const TIER_LABEL: Record<string, string> = {
  free: "Free",
  basic: "Basic",
  plus: "Plus",
  max: "Max",
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
  const setNickname = useMutation({
    mutationFn: ({ id, nickname }: { id: string; nickname: string }) =>
      api.admin.setUserNickname(id, nickname),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      toast("已更新暱稱", "success", 2000);
    },
    onError: (e) => toast(`更新失敗:${friendlyApiError(e)}`, "error", 4000),
  });
  const setPages = useMutation({
    mutationFn: ({ id, pages }: { id: string; pages: string[] | null }) =>
      api.admin.setUserPages(id, pages),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["admin", "whoami"] });
      toast("已更新頁面權限", "success", 2000);
    },
    onError: (e) => toast(`更新失敗:${friendlyApiError(e)}`, "error", 4000),
  });
  const [pagesUser, setPagesUser] = useState<AdminUser | null>(null);

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
                <th className="px-3 py-2">暱稱</th>
                <th className="px-3 py-2">fb_user_id</th>
                <th className="px-3 py-2">方案</th>
                <th className="px-3 py-2">權限</th>
                <th className="px-3 py-2">頁面權限</th>
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
                  onNickname={(nickname) => setNickname.mutate({ id: u.fb_user_id, nickname })}
                  onEditPages={() => setPagesUser(u)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pagesUser && (
        <PagePermsModal
          user={pagesUser}
          saving={setPages.isPending}
          onClose={() => setPagesUser(null)}
          onSave={(pages) => {
            setPages.mutate({ id: pagesUser.fb_user_id, pages });
            setPagesUser(null);
          }}
        />
      )}
    </Modal>
  );
}

/** Per-user 頁面權限 editor — checkboxes for each sidebar page. All
 *  checked → saves null (= all pages, incl. future ones). */
function PagePermsModal({
  user,
  saving,
  onClose,
  onSave,
}: {
  user: AdminUser;
  saving: boolean;
  onClose: () => void;
  onSave: (pages: string[] | null) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(user.page_perms ?? ALL_PAGE_KEYS),
  );
  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const save = () => {
    const arr = ALL_PAGE_KEYS.filter((k) => selected.has(k));
    onSave(arr.length === ALL_PAGE_KEYS.length ? null : arr);
  };
  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="頁面權限"
      subtitle={user.nickname || user.name || user.fb_user_id}
      width={340}
    >
      <div className="flex flex-col gap-0.5">
        {GATED_PAGES.map((p) => (
          <label
            key={p.key}
            className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-[13px] text-ink hover:bg-bg"
          >
            <input
              type="checkbox"
              className="custom-cb"
              checked={selected.has(p.key)}
              onChange={() => toggle(p.key)}
            />
            {p.label}
          </label>
        ))}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(ALL_PAGE_KEYS))}>
          全選
        </Button>
        <Button variant="primary" size="sm" onClick={save} disabled={saving}>
          儲存
        </Button>
      </div>
    </Modal>
  );
}

function UserRow({
  user,
  isDefaultAdmin,
  busy,
  onRole,
  onNickname,
  onEditPages,
}: {
  user: AdminUser;
  isDefaultAdmin: boolean;
  busy: boolean;
  onRole: (role: "admin" | "user") => void;
  onNickname: (nickname: string) => void;
  onEditPages: () => void;
}) {
  const allowedCount = user.page_perms == null ? ALL_PAGE_KEYS.length : user.page_perms.length;
  // Admins always bypass page gating (canSeePage), so editing their page
  // perms has no effect — disable the button for them.
  const isAdmin = isDefaultAdmin || user.role === "admin";
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
      <td className="px-3 py-2">
        <NicknameCell value={user.nickname ?? ""} onSave={onNickname} />
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
      <td className="px-3 py-2">
        {isAdmin ? (
          <span className="text-[12px] text-gray-300">全部(管理員)</span>
        ) : (
          <button
            type="button"
            onClick={onEditPages}
            className="h-[28px] rounded-md border border-border bg-white px-2.5 text-[12px] text-gray-500 transition hover:border-orange hover:text-orange"
          >
            {user.page_perms == null ? "全部" : `${allowedCount}/${ALL_PAGE_KEYS.length}`}
          </button>
        )}
      </td>
    </tr>
  );
}

/** Inline editable nickname — saves on blur or Enter (only when changed). */
function NicknameCell({ value, onSave }: { value: string; onSave: (v: string) => void }) {
  const [draft, setDraft] = useState(value);
  // Keep in sync when the server value changes (e.g. after a refetch).
  useEffect(() => {
    setDraft(value);
  }, [value]);
  const commit = () => {
    if (draft.trim() !== value.trim()) onSave(draft.trim());
  };
  return (
    <input
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
      }}
      placeholder="—"
      className="h-[28px] w-[120px] rounded-md border border-border bg-white px-2 text-[12px] outline-none focus:border-orange"
    />
  );
}

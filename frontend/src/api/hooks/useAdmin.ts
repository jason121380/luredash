import { api } from "@/api/client";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { useQuery } from "@tanstack/react-query";

function useWhoami() {
  const { status } = useFbAuth();
  return useQuery({
    queryKey: ["admin", "whoami"],
    queryFn: () => api.admin.whoami(),
    enabled: status === "auth",
    staleTime: 5 * 60_000,
  });
}

/**
 * Whether the current session belongs to an admin — drives the 管理員 nav
 * group visibility. Server-authoritative (allowlist lives in the DB).
 */
export function useIsAdmin(): boolean {
  return useWhoami().data?.is_admin ?? false;
}

/**
 * The current user's allowed sidebar pages, or null = all allowed.
 * Drives per-user page gating in the sidebar.
 */
export function usePagePerms(): string[] | null {
  return useWhoami().data?.page_perms ?? null;
}

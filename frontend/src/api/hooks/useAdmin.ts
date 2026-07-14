import { api } from "@/api/client";
import { useFbAuth } from "@/auth/FbAuthProvider";
import { useQuery } from "@tanstack/react-query";

/**
 * Whether the current session belongs to an admin — drives the 管理員 nav
 * group visibility. Server-authoritative (allowlist lives in the DB).
 */
export function useIsAdmin(): boolean {
  const { status } = useFbAuth();
  const q = useQuery({
    queryKey: ["admin", "whoami"],
    queryFn: () => api.admin.whoami(),
    enabled: status === "auth",
    staleTime: 5 * 60_000,
  });
  return q.data?.is_admin ?? false;
}

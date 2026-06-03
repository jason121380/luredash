import { ApiError, api, setApiSessionToken, setApiUserId } from "@/api/client";
import { useQueryClient } from "@tanstack/react-query";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

/**
 * Facebook JS SDK provider — replaces the window-level `fbAsyncInit`
 * dance in the original design with a React context. The SDK is loaded
 * exactly once per page using a module-level flag (survives React 18
 * Strict Mode's double-mount behavior).
 *
 * Auth state flow:
 *   1. Load FB SDK script (once)
 *   2. Call FB.getLoginStatus → if 'connected', POST token to FastAPI
 *      /api/auth/token so the server's _runtime_token is set before
 *      TanStack Query starts firing authenticated calls
 *   3. Expose `{status, user, login, logout}` via useFbAuth()
 *
 * The status field mirrors the legacy states: "checking" while SDK
 * loads, "unauth" when not logged in, "auth" after successful login.
 * Errors during token exchange surface via the `error` field.
 */

const FB_APP_ID = "2780372365654462";
const FB_API_VERSION = "v21.0";
const FB_LOCALE = "zh_TW";
// Scopes requested at FB Login time.
//
// - ads_read / ads_management: read campaigns + insights + creatives,
//   toggle status, update budgets. The core dashboard surface.
// - business_management: read the `business` field on /me/adaccounts
//   (needed for the FB Ads Manager deep-link URLs).
// - pages_read_engagement: OPTIONAL — grants read access to page post
//   content (full_picture, attachments.media.source). If the token
//   actually receives this scope (app admins/devs get it
//   automatically in dev mode; production users get it only after
//   FB App Review), the `/api/posts/{id}/media` fallback for FB
//   front-stage posts starts returning real CDN URLs, and users see
//   sharp preview images instead of the "can't load preview" text
//   fallback. When the scope is silently dropped by FB (app not
//   reviewed + user has no app role), everything keeps working via
//   the 600px creative-edge hires thumbnail + text-fallback path.
const FB_SCOPES = "ads_read,ads_management,business_management,pages_read_engagement";

declare global {
  interface Window {
    FB?: FbSdk;
    fbAsyncInit?: () => void;
  }
}

interface FbSdk {
  init: (opts: { appId: string; cookie: boolean; xfbml: boolean; version: string }) => void;
  getLoginStatus: (cb: (resp: FbLoginStatusResponse) => void) => void;
  login: (cb: (resp: FbLoginStatusResponse) => void, opts: { scope: string }) => void;
  logout: (cb?: () => void) => void;
  api: (path: string, params: Record<string, string>, cb: (resp: unknown) => void) => void;
}

interface FbLoginStatusResponse {
  status: "connected" | "not_authorized" | "unknown";
  authResponse?: { accessToken: string; userID: string };
}

export type FbAuthStatus = "checking" | "unauth" | "auth";

export interface FbAuthUser {
  id: string;
  name: string;
  pictureUrl?: string;
}

export interface FbAuthContextValue {
  status: FbAuthStatus;
  user: FbAuthUser | null;
  error: string | null;
  cooldownUntil: number | null;
  login: () => void;
  logout: () => Promise<void>;
}

const FbAuthContext = createContext<FbAuthContextValue | null>(null);

// Module-level so double-mount in Strict Mode doesn't re-inject the
// SDK script tag twice.
let sdkLoading = false;
let sdkReady = false;
const sdkCallbacks: Array<() => void> = [];
const AUTH_COOLDOWN_KEY = "meta_dash_fb_auth_cooldown_until";
const AUTH_COOLDOWN_FALLBACK_MS = 10 * 60_000;

function ensureSdkLoaded(): Promise<void> {
  if (sdkReady) return Promise.resolve();
  return new Promise((resolve) => {
    sdkCallbacks.push(resolve);
    if (sdkLoading) return;
    sdkLoading = true;

    window.fbAsyncInit = () => {
      window.FB?.init({
        appId: FB_APP_ID,
        cookie: true,
        xfbml: true,
        version: FB_API_VERSION,
      });
      sdkReady = true;
      const pending = sdkCallbacks.splice(0);
      for (const fn of pending) fn();
    };

    const d = document;
    const id = "facebook-jssdk";
    if (d.getElementById(id)) return;
    const script = d.createElement("script");
    script.id = id;
    script.src = `https://connect.facebook.net/${FB_LOCALE}/sdk.js`;
    script.async = true;
    script.defer = true;
    d.head.appendChild(script);
  });
}

function getStoredAuthCooldown(): number | null {
  try {
    const raw = localStorage.getItem(AUTH_COOLDOWN_KEY);
    const until = raw ? Number(raw) : 0;
    if (Number.isFinite(until) && until > Date.now()) return until;
    localStorage.removeItem(AUTH_COOLDOWN_KEY);
  } catch {
    /* ignore */
  }
  return null;
}

function rememberAuthCooldown(detail: string): number {
  const match = detail.match(/(\d+)\s*秒/);
  const waitMs = match ? Math.max(30_000, Number(match[1]) * 1000) : AUTH_COOLDOWN_FALLBACK_MS;
  const until = Date.now() + waitMs;
  try {
    localStorage.setItem(AUTH_COOLDOWN_KEY, String(until));
  } catch {
    /* ignore */
  }
  return until;
}

export function FbAuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<FbAuthStatus>("checking");
  const [user, setUser] = useState<FbAuthUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cooldownUntil, setCooldownUntil] = useState<number | null>(() => getStoredAuthCooldown());
  const didRunRef = useRef(false);
  const queryClient = useQueryClient();

  const exchangeToken = useCallback(
    async (token: string) => {
      try {
        const activeCooldown = getStoredAuthCooldown();
        if (activeCooldown) {
          setCooldownUntil(activeCooldown);
          setError("FB 登入驗證冷卻中,先不要重複點登入。系統目前不會再呼叫 FB。");
          setStatus("unauth");
          return;
        }
        // Fast path: if we recently verified this exact token (same
        // browser, < 4 min ago), reuse the cached user info and skip
        // the POST entirely. Each POST is a /me round-trip on the
        // backend cache miss path, and a multi-tab page reload would
        // otherwise fan out to N concurrent verifies → app-level
        // rate limit. The backend has its own dedup lock, but
        // skipping the round-trip is even cheaper.
        const VERIFY_CACHE_KEY = "meta_dash_fb_verified";
        const VERIFY_CACHE_TTL = 4 * 60_000;
        try {
          const cached = localStorage.getItem(VERIFY_CACHE_KEY);
          if (cached) {
            const parsed = JSON.parse(cached) as {
              token?: string;
              id?: string;
              name?: string;
              pictureUrl?: string;
              sessionToken?: string;
              sessionExpiresAt?: number;
              at?: number;
            };
            if (
              parsed.token === token &&
              parsed.id &&
              parsed.sessionToken &&
              typeof parsed.sessionExpiresAt === "number" &&
              parsed.sessionExpiresAt * 1000 > Date.now() + 60_000 &&
              typeof parsed.at === "number" &&
              Date.now() - parsed.at < VERIFY_CACHE_TTL
            ) {
              setApiUserId(parsed.id);
              setApiSessionToken(parsed.sessionToken);
              setUser({
                id: parsed.id,
                name: parsed.name ?? "User",
                pictureUrl: parsed.pictureUrl,
              });
              setStatus("auth");
              setError(null);
              return;
            }
          }
        } catch {
          /* fall through to real verify */
        }

        const result = await api.auth.setToken(token);
        // Cache token locally to survive refreshes without relying on FB cookies
        localStorage.setItem("meta_dash_fb_token", token);

        const name = result.name ?? "User";
        const id = result.id ?? "";
        const pictureUrl = result.pictureUrl;
        const sessionToken = result.sessionToken ?? "";
        const sessionExpiresAt = result.sessionExpiresAt ?? 0;

        try {
          localStorage.setItem(
            VERIFY_CACHE_KEY,
            JSON.stringify({
              token,
              id,
              name,
              pictureUrl,
              sessionToken,
              sessionExpiresAt,
              at: Date.now(),
            }),
          );
          if (sessionToken) localStorage.setItem("meta_dash_session_token", sessionToken);
          if (sessionExpiresAt) {
            localStorage.setItem("meta_dash_session_expires_at", String(sessionExpiresAt));
          }
        } catch {
          /* quota — ignore */
        }

        // Register the user id with the api client BEFORE flipping
        // status → auth, so the first wave of data queries (fired by
        // resetQueries below) already carry the x-fb-user-id header
        // and resolve THIS user's token instead of racing the global
        // _runtime_token. This is the actual fix for the PWA
        // first-login empty-data bug.
        setApiUserId(id);
        setApiSessionToken(sessionToken);

        setUser({ id, name, pictureUrl });
        setStatus("auth");
        setError(null);
        setCooldownUntil(null);
        try {
          localStorage.removeItem(AUTH_COOLDOWN_KEY);
        } catch {
          /* ignore */
        }
        // Force every cached query to re-fetch with the new token.
        // Without this, if the backend had just restarted and was
        // returning 401 errors for existing queries, those stale
        // error states would linger until the user manually hit
        // the refresh button. `resetQueries` clears the error state
        // too, not just the data (vs invalidateQueries).
        queryClient.resetQueries();
      } catch (err) {
        localStorage.removeItem("meta_dash_fb_token");
        localStorage.removeItem("meta_dash_session_token");
        localStorage.removeItem("meta_dash_session_expires_at");
        setApiUserId(null);
        setApiSessionToken(null);
        const msg = err instanceof ApiError ? err.detail : (err as Error).message;
        if (err instanceof ApiError && err.status === 429) {
          setCooldownUntil(rememberAuthCooldown(msg));
        }
        setError(msg);
        setStatus("unauth");
      }
    },
    [queryClient],
  );

  useEffect(() => {
    // Guard against React 18 Strict Mode double-invoke so we don't
    // check login status twice. This effect is ONE-SHOT — no cleanup.
    if (didRunRef.current) return;
    didRunRef.current = true;

    // Safety fallback: if the FB SDK never loads (ad blocker, network),
    // reveal the login form after 6 seconds — matches legacy behavior.
    // We do NOT return a cleanup clearing this timer because cleanup
    // would also run on Strict Mode's synthetic unmount and cancel the
    // fallback; we rely on the functional `setStatus(prev => ...)`
    // update to only fire when the status is still "checking".
    setTimeout(() => {
      setStatus((prev) => (prev === "checking" ? "unauth" : prev));
    }, 6000);

    const activeCooldown = getStoredAuthCooldown();
    if (activeCooldown) {
      setCooldownUntil(activeCooldown);
      setError("FB 登入驗證冷卻中,先不要重複點登入。系統目前不會再呼叫 FB。");
      setStatus("unauth");
      return;
    }

    // Fast path: use cached token if available so we skip the
    // "checking" screen delay and bypass browser third-party cookie limits
    const cached = localStorage.getItem("meta_dash_fb_token");
    if (cached) {
      void exchangeToken(cached);
    }

    ensureSdkLoaded().then(() => {
      window.FB?.getLoginStatus((resp) => {
        if (resp.status === "connected" && resp.authResponse) {
          const fresh = resp.authResponse.accessToken;
          const cachedNow = localStorage.getItem("meta_dash_fb_token");
          localStorage.setItem("meta_dash_fb_token", fresh);
          // Retry with the FRESH token when:
          //   - no cached token at all (first load), OR
          //   - the cached attempt already failed and wiped its entry,
          //     leaving us in "unauth" with an error — FB still has a
          //     live session so we can self-heal without making the user
          //     click anything.
          //   - cached value differs from the fresh one (cached was stale)
          const cachedWasCleared = !!cached && !cachedNow;
          const cachedStale = !!cached && !!cachedNow && cachedNow !== fresh;
          if (!cached || cachedWasCleared || cachedStale) {
            void exchangeToken(fresh);
          }
        } else if (!cached) {
          setStatus((prev) => (prev === "checking" ? "unauth" : prev));
        }
      });
    });
  }, [exchangeToken]);

  const login = useCallback(() => {
    const activeCooldown = getStoredAuthCooldown();
    if (activeCooldown) {
      setCooldownUntil(activeCooldown);
      setError("FB 登入驗證冷卻中,先不要重複點登入。系統目前不會再呼叫 FB。");
      setStatus("unauth");
      return;
    }
    ensureSdkLoaded().then(() => {
      window.FB?.login(
        (resp) => {
          if (resp.authResponse) {
            void exchangeToken(resp.authResponse.accessToken);
          }
        },
        { scope: FB_SCOPES },
      );
    });
  }, [exchangeToken]);

  const logout = useCallback(async () => {
    try {
      window.FB?.logout();
    } catch {
      /* ignore */
    }
    try {
      await api.auth.clearToken();
    } catch {
      /* ignore */
    }
    localStorage.removeItem("meta_dash_fb_token");
    localStorage.removeItem("meta_dash_session_token");
    localStorage.removeItem("meta_dash_session_expires_at");
    localStorage.removeItem("meta_dash_fb_verified");
    localStorage.removeItem(AUTH_COOLDOWN_KEY);
    setCooldownUntil(null);
    setApiUserId(null);
    setApiSessionToken(null);
    setUser(null);
    setStatus("unauth");
  }, []);

  return (
    <FbAuthContext.Provider value={{ status, user, error, cooldownUntil, login, logout }}>
      {children}
    </FbAuthContext.Provider>
  );
}

/**
 * Stub auth provider for the public share page (`/r/:campaignId`).
 *
 * The share page has NO real FB login — viewers reach it via a link
 * shared on LINE/email and the backend serves data using its runtime
 * token. But `useFbAuth()` throws when no FbAuthContext is present,
 * and several modal hooks (CreativePreviewModal etc.) call it. Without
 * this stub, opening the creative preview on the share page crashes
 * the whole React tree → blank white screen.
 *
 * We supply `status: "auth"` so query gates like `enabled: status === "auth"`
 * fire normally; login/logout are no-ops because the share page has
 * no UI to invoke them.
 */
export function ShareModeAuthProvider({ children }: { children: ReactNode }) {
  return (
    <FbAuthContext.Provider
      value={{
        status: "auth",
        user: null,
        error: null,
        cooldownUntil: null,
        login: () => {},
        logout: async () => {},
      }}
    >
      {children}
    </FbAuthContext.Provider>
  );
}

export function useFbAuth(): FbAuthContextValue {
  const ctx = useContext(FbAuthContext);
  if (!ctx) {
    throw new Error("useFbAuth must be used inside <FbAuthProvider>");
  }
  return ctx;
}

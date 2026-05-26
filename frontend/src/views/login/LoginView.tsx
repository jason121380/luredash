import { useFbAuth } from "@/auth/FbAuthProvider";
import { Spinner } from "@/components/Spinner";
import { useEffect, useMemo, useState } from "react";

/**
 * Login page — full-screen split layout matching the original design lines
 * 765–798. Left: animated orange gradient blobs on dark panel. Right:
 * white card with METADASH wordmark and "Continue with Facebook" CTA.
 *
 * Three visible states:
 *   1. `checking` — FB SDK is still loading, spinner + "驗證登入狀態..."
 *   2. `unauth`   — show the login button
 *   3. (We never render LoginView when status is `auth`; the router
 *       redirects to /dashboard instead.)
 */
export function LoginView() {
  const { status, login, error, cooldownUntil } = useFbAuth();
  const [now, setNow] = useState(() => Date.now());
  const cooldownRemainingSec = cooldownUntil ? Math.max(0, Math.ceil((cooldownUntil - now) / 1000)) : 0;
  const isCoolingDown = cooldownRemainingSec > 0;
  const cooldownLabel = useMemo(() => {
    if (!isCoolingDown) return "";
    const min = Math.floor(cooldownRemainingSec / 60);
    const sec = cooldownRemainingSec % 60;
    return `${min}分${String(sec).padStart(2, "0")}秒`;
  }, [cooldownRemainingSec, isCoolingDown]);

  useEffect(() => {
    if (!cooldownUntil) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [cooldownUntil]);

  return (
    <div className="fixed inset-0 z-[9999] flex flex-col items-stretch justify-center bg-[#F2F2F2] md:flex-row">
      {/* Left brand panel — hidden on mobile, shown on desktop */}
      <div className="relative hidden flex-1 flex-col items-start justify-end overflow-hidden bg-[#1C1410] px-[60px] py-14 md:flex">
        <Blob
          className="-left-20 -top-24 h-[420px] w-[420px]"
          gradient="radial-gradient(circle, #FF6B2C 0%, #FF3D00 60%, transparent 100%)"
          animation="blob1 9s ease-in-out infinite alternate"
        />
        <Blob
          className="-bottom-16 -right-16 h-80 w-80"
          gradient="radial-gradient(circle, #FF8C42 0%, #E55A1C 70%, transparent 100%)"
          animation="blob2 11s ease-in-out infinite alternate"
        />
        <Blob
          className="left-[35%] top-[40%] h-52 w-52"
          gradient="radial-gradient(circle, #FFB347 0%, #FF6B2C 70%, transparent 100%)"
          animation="blob3 13s ease-in-out infinite alternate"
        />
        <div className="absolute inset-0 z-[1] bg-[rgba(20,10,5,0.25)]" />
        <div className="relative z-[2]">
          <div className="mb-6 h-1 w-11 rounded-sm bg-orange" />
          <div className="mb-3.5 text-[36px] font-extrabold leading-[1.1] tracking-[-1px] text-white">
            METADASH <span className="text-orange">by LURE</span>
          </div>
          <div className="max-w-[280px] text-sm leading-[1.7] text-white/45">
            統一管理所有 Meta 廣告帳戶，即時掌握成效數據與異常警示。
          </div>
        </div>
      </div>

      {/* Right login card.
          NOTE on padding — DO NOT use `px-13`/`py-15` here: those
          aren't real Tailwind spacing tokens (the scale jumps from
          12→14→16), so both classes were silently dropped and the
          440px card rendered with zero horizontal padding, which
          made `w-full` push the blue login button edge-to-edge ("太
          寬爆版"). `px-14 py-14` = 56px of padding on every side,
          which leaves ~328px for the button inside a 440px card. */}
      {/* Right login card — full width on mobile, fixed 440px on desktop.
          Safe-area padding ensures the card clears the notch / home
          indicator on iPhones in landscape. */}
      <div
        className="flex w-full shrink-0 flex-1 flex-col items-center justify-center bg-white px-8 py-10 text-center md:w-[440px] md:flex-initial md:px-14 md:py-14"
        style={{ paddingBottom: "max(40px, env(safe-area-inset-bottom))" }}
      >
        <div className="mb-1 text-[22px] font-extrabold tracking-[-0.3px] text-ink">
          METADASH <span className="text-orange">by LURE</span>
        </div>
        <div className="mb-12 text-xs tracking-[0.3px] text-gray-300">META 廣告管理平台</div>

        {status === "checking" ? (
          <div className="flex flex-col items-center gap-2.5 py-5 text-[13px] text-gray-300">
            <Spinner />
            <span>驗證登入狀態...</span>
          </div>
        ) : (
          <div className="w-full">
            <p className="mb-7 text-[13px] leading-[1.8] text-gray-500">
              使用 Facebook 帳號登入，即可查看並管理廣告帳戶的成效數據。
            </p>
            <button
              type="button"
              onClick={login}
              disabled={isCoolingDown}
              className="flex h-12 w-full cursor-pointer items-center justify-center gap-2.5 rounded-[10px] bg-[#1877f2] text-sm font-bold tracking-[0.2px] text-white transition-colors hover:bg-[#1464cc] disabled:cursor-not-allowed disabled:bg-gray-300"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="white" aria-hidden="true">
                <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
              </svg>
              {isCoolingDown ? `冷卻中 ${cooldownLabel}` : "使用 Facebook 帳號登入"}
            </button>
            {error && (
              <div className="mt-4 rounded-lg bg-red-bg px-3 py-2 text-xs text-red">{error}</div>
            )}
            <div className="mt-6 text-[11px] leading-[1.7] text-gray-300">
              登入即代表授權本應用程式讀取你的廣告數據
            </div>
          </div>
        )}
      </div>

      {/* Keyframes injected inline so we don't need a global stylesheet
          dependency for the login page. */}
      <style>{`
        @keyframes blob1 { 0% { transform: translate(0,0) scale(1); } 100% { transform: translate(40px,50px) scale(1.1); } }
        @keyframes blob2 { 0% { transform: translate(0,0) scale(1); } 100% { transform: translate(-30px,-40px) scale(1.15); } }
        @keyframes blob3 { 0% { transform: translate(0,0) scale(0.9); opacity: 0.35; } 100% { transform: translate(-20px,30px) scale(1.1); opacity: 0.55; } }
      `}</style>
    </div>
  );
}

function Blob({
  className,
  gradient,
  animation,
}: {
  className: string;
  gradient: string;
  animation: string;
}) {
  return (
    <div
      className={`pointer-events-none absolute rounded-full opacity-55 blur-[60px] ${className}`}
      style={{ background: gradient, animation }}
    />
  );
}

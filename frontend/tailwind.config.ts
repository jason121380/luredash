import type { Config } from "tailwindcss";

/**
 * Tailwind is configured to mirror the exact design tokens used in the
 * legacy dashboard.html :root block. Color names use the SAME strings as
 * the CSS variables (--orange, --gray-500, etc.) so we can freely mix
 * `var(--orange)` references with `bg-orange` utilities without drift.
 *
 * IMPORTANT — class-name invariant:
 *   NO generated CSS class or utility should ever start with `ad-`,
 *   because uBlock / AdBlock Plus filter lists match `[class^="ad-"]`
 *   and will hide the element. Use `creative-*` for ad-related classes.
 *   See: MEMORY.md for the full bug story (commit d720fa2).
 */
const config: Config = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        orange: {
          DEFAULT: "#FF6B2C",
          dark: "#E55A1C",
          bg: "#FFF5F0",
          // Softer warm-white used as a faint row background behind
          // third-level creatives in the dashboard tree. Keep separate
          // from `orange.bg` so row states (loading / empty) can step
          // through two distinct tints.
          soft: "#FFFCFA",
          border: "#FFE8D9",
          muted: "#B07A50",
        },
        ink: {
          DEFAULT: "#1A1A1A",
        },
        gray: {
          300: "#AAAAAA",
          500: "#666666",
        },
        bg: {
          DEFAULT: "#FAFAFA",
          white: "#FFFFFF",
        },
        border: {
          DEFAULT: "#F0F0F0",
          strong: "#E0E0E0",
        },
        green: {
          DEFAULT: "#2E7D32",
          bg: "#E8F5E9",
        },
        red: {
          DEFAULT: "#C62828",
          bg: "#FFEBEE",
          // Hover tint for danger buttons — one step darker than
          // `red.bg` so the button visibly reacts on hover without
          // losing the soft-red identity.
          bgHover: "#FFCDD2",
        },
        yellow: {
          DEFAULT: "#E65100",
          bg: "#FFF3E0",
        },
      },
      fontFamily: {
        sans: [
          '"Noto Sans TC"',
          "-apple-system",
          "BlinkMacSystemFont",
          '"Segoe UI"',
          "sans-serif",
        ],
      },
      borderRadius: {
        DEFAULT: "12px",
        sm: "8px",
        pill: "50px",
      },
      boxShadow: {
        sm: "0 2px 8px rgba(0,0,0,0.06)",
        md: "0 4px 24px rgba(0,0,0,0.08)",
      },
      spacing: {
        // Single source of truth for the desktop left-sidebar width.
        // Sidebar + Shell both read it via `w-sidebar` / `ml-sidebar`.
        // Mobile (<768px) uses a 300px drawer width declared in
        // globals.css and is unaffected by this token.
        sidebar: "200px",
      },
      fontSize: {
        xxs: ["10px", { lineHeight: "1.3" }],
      },
      keyframes: {
        shimmer: {
          "0%": { backgroundPosition: "200% 0" },
          "100%": { backgroundPosition: "-200% 0" },
        },
        // For <ProgressBar> — slower & in the opposite direction so
        // the gradient looks like it's flowing INTO the bar, not
        // sliding off it.
        "progress-shimmer": {
          "0%": { backgroundPosition: "100% 0" },
          "100%": { backgroundPosition: "0% 0" },
        },
        spin: {
          to: { transform: "rotate(360deg)" },
        },
        "fade-in": {
          from: { opacity: "0", transform: "translateY(6px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        slideUp: {
          from: { transform: "translateY(100%)" },
          to: { transform: "translateY(0)" },
        },
        indeterminate: {
          "0%": { transform: "translateX(-100%)" },
          "50%": { transform: "translateX(200%)" },
          "100%": { transform: "translateX(-100%)" },
        },
        "bounce-dot": {
          "0%, 80%, 100%": { transform: "scale(0.6)", opacity: "0.55" },
          "40%": { transform: "scale(1)", opacity: "1" },
        },
      },
      animation: {
        shimmer: "shimmer 1.2s infinite",
        "progress-shimmer": "progress-shimmer 1.8s linear infinite",
        spin: "spin 0.7s linear infinite",
        "fade-in": "fade-in 0.25s ease-out both",
        "bounce-dot": "bounce-dot 1.2s ease-in-out infinite both",
      },
    },
  },
  plugins: [],
};

export default config;

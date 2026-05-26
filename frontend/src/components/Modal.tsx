import { cn } from "@/lib/cn";
import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

/**
 * Modal — Radix Dialog primitive styled to match the original design's
 * `.overlay` + `.modal` classes (white card, 12px radius, 24px padding,
 * 360px default width, md shadow, 900 z-index).
 *
 * Uses controlled `open` / `onOpenChange` API (shadcn-style). Content
 * is centered via fixed positioning. Clicking outside or pressing
 * Escape dismisses the dialog — matches current `overlay onclick`
 * behavior in the original design.
 */

export interface ModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Extra content rendered in the sticky header row, between the
   * title column and the X close button. Typically used for a
   * call-to-action that belongs to the entire modal (e.g. the
   * creative preview modal's "view original post" link). */
  titleAction?: ReactNode;
  /** When true, omit the X close button AND the entire sticky
   * header row (assuming there's also no title / subtitle / action).
   * Used by the centered confirmation dialog so the body content
   * is visually balanced top-to-bottom — having an X close at the
   * top would push everything downward.  Backdrop tap and Esc
   * still close the dialog. */
  hideClose?: boolean;
  children?: ReactNode;
  footer?: ReactNode;
  width?: number | string;
  className?: string;
}

export function Modal({
  open,
  onOpenChange,
  title,
  subtitle,
  titleAction,
  hideClose,
  children,
  footer,
  width = 360,
  className,
}: ModalProps) {
  // Skip the entire sticky header row when there's nothing to show
  // in it. Radix still requires a Dialog.Title for a11y, so we
  // render one in sr-only form alongside the body.
  const showHeader = title || subtitle || titleAction || !hideClose;
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[900] bg-black/40 backdrop-blur-[1px] animate-fade-in" />
        <Dialog.Content
          style={
            {
              "--modal-w": typeof width === "number" ? `${width}px` : width,
            } as React.CSSProperties
          }
          // Mobile (<768px): iOS-style bottom sheet — pinned to
          // bottom of screen, full-width, rounded top corners only,
          // slides up via the `slideUp` keyframe.
          //
          // Desktop (≥768px): centered card — overrides mobile
          // positioning back to the classic centered-modal layout.
          className={cn(
            // Mobile default: bottom sheet
            "modal-sheet fixed inset-x-0 bottom-0 z-[901] w-full",
            // overflow-x-hidden prevents wide children (e.g. data
            // tables) from stretching the modal beyond viewport
            // width on mobile. They should scroll within their own
            // overflow-x-auto wrappers, not push the modal sideways.
            "max-h-[85vh] overflow-y-auto overflow-x-hidden rounded-t-2xl bg-white p-0 shadow-md",
            "focus:outline-none",
            "animate-[slideUp_0.3s_cubic-bezier(0.32,0.72,0,1)]",
            // Desktop override: centered card with constrained size
            "md:inset-0 md:m-auto md:h-fit md:max-h-[calc(100vh-48px)] md:max-w-[calc(100vw-24px)] md:w-[var(--modal-w)] md:rounded-2xl",
            "md:animate-fade-in",
            className,
          )}
        >
          {/* Radix Dialog REQUIRES Dialog.Title and Dialog.Description
              for a11y, even when we don't render them visibly. The
              sr-only fallbacks here keep screen-reader announcements
              correct in both header-on and header-hidden modes. */}
          {!showHeader && (
            <>
              <Dialog.Title className="sr-only">對話視窗</Dialog.Title>
              <Dialog.Description className="sr-only">對話視窗</Dialog.Description>
            </>
          )}
          {/* Sticky header — title on the left, optional title-action
              + close X on the right. Stays pinned to the top of the
              scrollable area when body content is taller than the
              viewport. Skipped entirely when `hideClose` is set and
              there's no title / subtitle / action to render — this
              is what the centered ConfirmDialog uses so the body
              content is balanced top-to-bottom. */}
          {showHeader && (
            <div className="sticky top-0 z-10 flex items-center gap-2 bg-white px-5 pt-5 md:px-6 md:pt-6">
              <div className="min-w-0 flex-1">
                {title ? (
                  <Dialog.Title className="mb-1 text-[15px] font-bold text-ink md:text-base">
                    {title}
                  </Dialog.Title>
                ) : (
                  <Dialog.Title className="sr-only">對話視窗</Dialog.Title>
                )}
                {subtitle ? (
                  <Dialog.Description className="text-xs text-gray-500">
                    {subtitle}
                  </Dialog.Description>
                ) : (
                  <Dialog.Description className="sr-only">{title ?? "對話視窗"}</Dialog.Description>
                )}
              </div>
              {titleAction && <div className="shrink-0">{titleAction}</div>}
              {!hideClose && (
                // X 關閉按鈕 — 多重保險:
                //   1. Dialog.Close asChild → 取得 Radix 內建 robust
                //      click 處理 + 焦點管理(會自動 onOpenChange(false))
                //   2. 我們自己的 onClick → 備援,iOS WKWebView 在
                //      Radix focus trap 內偶爾會吃掉 click,直接綁
                //      確保即使 Radix 內部沒觸發 close 也會關閉
                //   3. onPointerUp → iOS / LINE in-app browser 上
                //      pointer event 比 click 更可靠 (沒 300ms tap
                //      delay,也不受 focus trap 干擾)
                //   4. SVG pointer-events:none → 點擊只命中 button,
                //      防止 line/path 元素吞掉觸控
                //   5. touch-action:manipulation → 移除 iOS 預設的
                //      雙擊縮放延遲,讓 tap 立刻觸發
                <Dialog.Close asChild>
                  <button
                    type="button"
                    aria-label="關閉"
                    onClick={() => onOpenChange(false)}
                    onPointerUp={() => onOpenChange(false)}
                    style={{ touchAction: "manipulation" }}
                    className="-mr-2 flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-500 hover:bg-bg hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange/40 md:-mr-3"
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      className="pointer-events-none"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>
                </Dialog.Close>
              )}
            </div>
          )}
          <div
            className={cn(
              "px-5 pb-5 md:px-6 md:pb-6",
              // When the header is rendered, the body sits below it
              // and only needs a small top gap. When the header is
              // hidden, the body uses the full top padding so the
              // first row of content has equal breathing room top
              // and bottom.
              showHeader ? "pt-4" : "pt-5 md:pt-6",
            )}
          >
            {children}
            {footer && <div className="mt-4 flex justify-end gap-2">{footer}</div>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

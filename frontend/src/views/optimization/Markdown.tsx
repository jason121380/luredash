import { Fragment } from "react";

/**
 * Tiny markdown renderer for agent advice output. Handles ONLY the
 * subset Gemini reliably produces:
 *
 *   ## h2 / ### h3
 *   - bullet list (or `*` bullet)
 *   1. numbered list
 *   **bold**
 *   `inline code`
 *   blank line → paragraph break
 *
 * Special: every `## 帳戶名稱` section is rendered as an account
 * card. The backend now asks Gemini to group to-dos by ad account
 * and then by severity, so the UI should make that hierarchy obvious.
 *
 * No GFM tables, no images, no HTML — agent advice is short prose
 * + bullets and we trust the LLM to stay in this lane via the
 * system prompt. Pulling react-markdown + its remark/rehype tree
 * would add ~60KB of JS for output we render once per page load.
 */
export function Markdown({ children }: { children: string }) {
  const blocks = parseBlocks(children);
  return (
    <div className="min-w-0 break-words text-[13px] leading-[1.7] text-ink [overflow-wrap:anywhere]">
      <div className="flex min-w-0 flex-col gap-2">{renderGrouped(blocks)}</div>
    </div>
  );
}

type Block =
  | { type: "h2" | "h3" | "p"; text: string }
  | { type: "ul" | "ol"; items: string[] };

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    if (raw === undefined) {
      i++;
      continue;
    }
    const line = raw.trimEnd();
    if (!line.trim()) {
      i++;
      continue;
    }
    if (line.startsWith("### ")) {
      blocks.push({ type: "h3", text: line.slice(4) });
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      blocks.push({ type: "h2", text: line.slice(3) });
      i++;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (cur === undefined) break;
        const m = cur.match(/^[-*]\s+(.*)$/);
        if (!m) break;
        items.push(m[1] ?? "");
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        if (cur === undefined) break;
        const m = cur.match(/^\d+\.\s+(.*)$/);
        if (!m) break;
        items.push(m[1] ?? "");
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }
    const paragraphLines: string[] = [line];
    i++;
    while (i < lines.length) {
      const cur = lines[i];
      if (cur === undefined) break;
      const trimmed = cur.trim();
      if (!trimmed) break;
      if (
        trimmed.startsWith("## ") ||
        trimmed.startsWith("### ") ||
        /^[-*]\s+/.test(trimmed) ||
        /^\d+\.\s+/.test(trimmed)
      ) {
        break;
      }
      paragraphLines.push(trimmed);
      i++;
    }
    blocks.push({ type: "p", text: paragraphLines.join(" ") });
  }
  return blocks;
}

/** Walk the block list and group every h2 with the blocks following
 *  it (until the next h2) into a compact account card. */
function renderGrouped(blocks: Block[]): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b === undefined) {
      i++;
      continue;
    }
    if (b.type === "h2") {
      const group: Block[] = [b];
      i++;
      while (i < blocks.length) {
        const next = blocks[i];
        if (next === undefined) break;
        if (next.type === "h2") break;
        group.push(next);
        i++;
      }
      out.push(
        <details
          key={`account-${i}`}
          open
          className="group min-w-0 overflow-visible rounded-xl border border-border bg-white p-3"
        >
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
            <h2 className="min-w-0 truncate text-[15px] font-bold text-ink">
              {renderInline(b.text)}
            </h2>
            <span
              className="shrink-0 text-[12px] text-gray-300 transition-transform group-open:rotate-180"
              aria-hidden="true"
            >
              ▼
            </span>
          </summary>
          <div className="mt-2 flex flex-col gap-1.5">
            {group.slice(1).map((g, j) => (
              <BlockNode key={j} block={g} inAccountCard />
            ))}
          </div>
        </details>,
      );
      continue;
    }
    out.push(<BlockNode key={i} block={b} />);
    i++;
  }
  return out;
}

function BlockNode({ block, inAccountCard = false }: { block: Block; inAccountCard?: boolean }) {
  if (block.type === "h2") {
    return (
      <h2
        className={
          inAccountCard
            ? "text-[15px] font-bold text-ink"
            : "mt-1 text-[14px] font-bold text-ink"
        }
      >
        {renderInline(block.text)}
      </h2>
    );
  }
  if (block.type === "h3") {
    const severityClass = getSeverityClass(block.text);
    return (
      <h3
        className={`mt-1 w-fit rounded-pill px-2 py-0.5 text-[12px] font-bold ${severityClass}`}
      >
        {renderInline(block.text)}
      </h3>
    );
  }
  if (block.type === "ul") {
    return (
      <ul
        className={
          inAccountCard
            ? "m-0 flex min-w-0 list-disc flex-col gap-1 pl-5 text-ink marker:text-orange"
            : "m-0 flex min-w-0 list-disc flex-col gap-1 pl-5"
        }
      >
        {block.items.map((it, j) => (
          <li key={j} className="min-w-0 break-words [overflow-wrap:anywhere]">
            {renderInline(it)}
          </li>
        ))}
      </ul>
    );
  }
  if (block.type === "ol") {
    return (
      <ol
        className={
          inAccountCard
            ? "m-0 flex min-w-0 list-decimal flex-col gap-1 pl-5 font-medium text-ink marker:font-bold marker:text-orange"
            : "m-0 flex min-w-0 list-decimal flex-col gap-1 pl-5"
        }
      >
        {block.items.map((it, j) => (
          <li key={j} className="min-w-0 break-words [overflow-wrap:anywhere]">
            {renderInline(it)}
          </li>
        ))}
      </ol>
    );
  }
  if (block.type === "p") {
    return <p className="m-0 min-w-0 break-words [overflow-wrap:anywhere]">{renderInline(block.text)}</p>;
  }
  return null;
}

function getSeverityClass(text: string): string {
  const norm = text.trim();
  if (norm.includes("嚴重") || norm.includes("高")) {
    return "bg-red-50 text-red-600";
  }
  if (norm.includes("中")) {
    return "bg-orange-50 text-orange";
  }
  if (norm.includes("低")) {
    return "bg-gray-100 text-gray-500";
  }
  return "bg-bg text-gray-600";
}

/** Inline parsing: **bold** and `code`. Keep it simple — agents
 *  rarely use anything more exotic and we'd rather fall back to
 *  literal text than render half-broken markup. */
function renderInline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter((p) => p.length > 0);
  return parts.map((p, i) => {
    if (p.startsWith("**") && p.endsWith("**")) {
      return (
        <strong key={i} className="font-semibold text-ink">
          {p.slice(2, -2)}
        </strong>
      );
    }
    if (p.startsWith("`") && p.endsWith("`")) {
      return (
        <code key={i} className="rounded bg-bg px-1 font-mono text-[12px]">
          {p.slice(1, -1)}
        </code>
      );
    }
    return <Fragment key={i}>{p}</Fragment>;
  });
}

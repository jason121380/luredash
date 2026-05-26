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
 * Special: any `## 優先` (or 「Action」 / 「Priority」 / 「待辦」)
 * heading + the blocks following it (until the next h2) are rendered
 * as an orange callout card so the operator's eye lands on the
 * "do this today" list immediately.
 *
 * No GFM tables, no images, no HTML — agent advice is short prose
 * + bullets and we trust the LLM to stay in this lane via the
 * system prompt. Pulling react-markdown + its remark/rehype tree
 * would add ~60KB of JS for output we render once per page load.
 */
export function Markdown({ children }: { children: string }) {
  const blocks = parseBlocks(children);
  return <div className="flex flex-col gap-2 text-[13px] leading-[1.7] text-ink">{renderGrouped(blocks)}</div>;
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

/** True when an h2 looks like the agent's "do this today" section.
 *  Both the system prompt and English / Chinese variants are matched
 *  defensively in case Gemini deviates from the requested wording. */
function isActionPlanHeading(text: string): boolean {
  const norm = text.replace(/[\s:：]/g, "").toLowerCase();
  return (
    norm.includes("優先") ||
    norm.includes("priority") ||
    norm.includes("actionplan") ||
    norm.includes("action") ||
    norm.includes("待辦") ||
    norm.includes("todo")
  );
}

/** Walk the block list and group any action-plan h2 with all
 *  blocks following it (until the next h2) into an orange callout
 *  wrapper. Everything else renders inline. */
function renderGrouped(blocks: Block[]): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < blocks.length) {
    const b = blocks[i];
    if (b === undefined) {
      i++;
      continue;
    }
    if (b.type === "h2" && isActionPlanHeading(b.text)) {
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
        <div
          key={`callout-${i}`}
          className="mt-1 rounded-xl border-l-4 border-orange bg-[#FFF5F0] p-3 shadow-sm"
        >
          <div className="mb-1 flex items-center gap-1.5 text-[12px] font-bold uppercase tracking-wide text-orange">
            <span>優先</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {group.map((g, j) => (
              <BlockNode key={j} block={g} inCallout />
            ))}
          </div>
        </div>,
      );
      continue;
    }
    out.push(<BlockNode key={i} block={b} />);
    i++;
  }
  return out;
}

function BlockNode({ block, inCallout = false }: { block: Block; inCallout?: boolean }) {
  if (block.type === "h2") {
    // Hide the literal "優先" text inside the callout — the pinned
    // label above already does the job.
    if (inCallout) return null;
    return <h2 className="mt-1 text-[14px] font-bold text-ink">{renderInline(block.text)}</h2>;
  }
  if (block.type === "h3") {
    return (
      <h3 className="mt-1 text-[13px] font-semibold text-ink/90">
        {renderInline(block.text)}
      </h3>
    );
  }
  if (block.type === "ul") {
    return (
      <ul
        className={
          inCallout
            ? "m-0 flex list-disc flex-col gap-1 pl-5 text-ink marker:text-orange"
            : "m-0 flex list-disc flex-col gap-1 pl-5"
        }
      >
        {block.items.map((it, j) => (
          <li key={j}>{renderInline(it)}</li>
        ))}
      </ul>
    );
  }
  if (block.type === "ol") {
    return (
      <ol
        className={
          inCallout
            ? "m-0 flex list-decimal flex-col gap-1 pl-5 font-medium text-ink marker:font-bold marker:text-orange"
            : "m-0 flex list-decimal flex-col gap-1 pl-5"
        }
      >
        {block.items.map((it, j) => (
          <li key={j}>{renderInline(it)}</li>
        ))}
      </ol>
    );
  }
  if (block.type === "p") {
    return <p className="m-0">{renderInline(block.text)}</p>;
  }
  return null;
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

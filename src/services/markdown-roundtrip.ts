import { createHash } from "node:crypto";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { FoundationServiceError } from "@/services/foundation/errors";
import type { ProseMirrorNode } from "@/services/pages";

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const supportedTopLevelTypes = new Set([
  "space", "paragraph", "heading", "list", "blockquote", "code", "table", "hr",
]);
const protectedTokenTypes = new Set(["html", "def"]);

export type MarkdownBlock = {
  index: number;
  type: string;
  start: number;
  end: number;
  raw: string;
  protected: boolean;
  protectedReason: string | null;
};
export type MarkdownAnalysis = {
  sourceHash: string;
  mode: "rich" | "source_only";
  warnings: string[];
  blocks: MarkdownBlock[];
  protectedBlockCount: number;
  renderedHtml: string;
};
export type MarkdownEditProposal = {
  baseHash: string;
  candidateHash: string;
  candidateMarkdown: string;
  changedBlocks: Array<{ index: number; beforeHash: string; afterHash: string }>;
  protectedBlocksPreserved: boolean;
  renderedHtml: string;
  warnings: string[];
};

type MarkedToken = { type?: unknown; raw?: unknown; text?: unknown; depth?: unknown; items?: unknown; tokens?: unknown };

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function validateSource(source: string) {
  if (Buffer.byteLength(source) > MAX_MARKDOWN_BYTES) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Markdown source must be at most 2 MiB.");
  }
  if (source.includes("\u0000")) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Markdown source cannot contain NUL bytes.");
  }
}

function frontMatterRange(source: string): { start: number; end: number; raw: string } | null {
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  return match ? { start: 0, end: match[0].length, raw: match[0] } : null;
}

function hasUnbalancedFence(source: string): boolean {
  const stack: Array<{ marker: string; length: number }> = [];
  for (const line of source.split(/\r?\n/)) {
    const match = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (!match) continue;
    const marker = match[1]![0]!;
    const length = match[1]!.length;
    const current = stack.at(-1);
    if (current && current.marker === marker && length >= current.length) stack.pop();
    else if (!current) stack.push({ marker, length });
  }
  return stack.length > 0;
}

function protectedReason(type: string, raw: string): string | null {
  if (type === "front_matter") return "front_matter";
  if (protectedTokenTypes.has(type)) return type === "html" ? "raw_html" : "reference_definition";
  if (/^\s*(?:import|export)\s/m.test(raw) || /<\/?[A-Z][A-Za-z0-9.]*(?:\s|>|\/)/.test(raw)) return "mdx_or_jsx";
  if (/^\s*:::[A-Za-z_-]/m.test(raw) || /^\s*@[A-Za-z_-]+\b/m.test(raw)) return "custom_directive";
  return supportedTopLevelTypes.has(type) ? null : "unsupported_token";
}

function render(source: string): string {
  const html = marked.parse(source, { gfm: true, breaks: false, async: false }) as string;
  return sanitizeHtml(html, {
    allowedTags: [
      "p", "br", "strong", "em", "del", "blockquote", "code", "pre", "ul", "ol", "li",
      "h1", "h2", "h3", "h4", "h5", "h6", "hr", "a", "img", "table", "thead", "tbody",
      "tr", "th", "td", "input",
    ],
    allowedAttributes: {
      a: ["href", "title", "rel", "target"],
      img: ["src", "alt", "title"],
      input: ["type", "checked", "disabled"],
      code: ["class"],
      th: ["align"],
      td: ["align"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noreferrer noopener", target: "_blank" }, true),
      input: sanitizeHtml.simpleTransform("input", { disabled: "disabled" }, true),
    },
  });
}

export function analyzeMarkdown(source: string): MarkdownAnalysis {
  validateSource(source);
  const warnings: string[] = [];
  if (hasUnbalancedFence(source)) warnings.push("unbalanced_fenced_code");
  let cursor = 0;
  const blocks: MarkdownBlock[] = [];
  const frontMatter = frontMatterRange(source);
  if (frontMatter) {
    blocks.push({
      index: blocks.length,
      type: "front_matter",
      start: frontMatter.start,
      end: frontMatter.end,
      raw: frontMatter.raw,
      protected: true,
      protectedReason: "front_matter",
    });
    cursor = frontMatter.end;
  }
  const body = source.slice(cursor);
  let tokens: MarkedToken[];
  try {
    tokens = marked.lexer(body, { gfm: true }) as unknown as MarkedToken[];
  } catch {
    return {
      sourceHash: digest(source),
      mode: "source_only",
      warnings: [...warnings, "parser_error"],
      blocks,
      protectedBlockCount: blocks.length,
      renderedHtml: "",
    };
  }
  for (const token of tokens) {
    const raw = typeof token.raw === "string" ? token.raw : "";
    const type = typeof token.type === "string" ? token.type : "unknown";
    if (!raw) continue;
    const found = source.indexOf(raw, cursor);
    if (found < cursor) {
      warnings.push("source_position_unresolved");
      continue;
    }
    if (found > cursor) {
      const gap = source.slice(cursor, found);
      if (gap) {
        blocks.push({
          index: blocks.length,
          type: "raw_gap",
          start: cursor,
          end: found,
          raw: gap,
          protected: true,
          protectedReason: "unparsed_source",
        });
      }
    }
    const reason = protectedReason(type, raw);
    blocks.push({
      index: blocks.length,
      type,
      start: found,
      end: found + raw.length,
      raw,
      protected: reason !== null,
      protectedReason: reason,
    });
    cursor = found + raw.length;
  }
  if (cursor < source.length) {
    blocks.push({
      index: blocks.length,
      type: "raw_tail",
      start: cursor,
      end: source.length,
      raw: source.slice(cursor),
      protected: true,
      protectedReason: "unparsed_source",
    });
  }
  const sourceOnly = warnings.includes("unbalanced_fenced_code")
    || warnings.includes("parser_error")
    || warnings.includes("source_position_unresolved");
  return {
    sourceHash: digest(source),
    mode: sourceOnly ? "source_only" : "rich",
    warnings,
    blocks,
    protectedBlockCount: blocks.filter((block) => block.protected).length,
    renderedHtml: sourceOnly ? "" : render(source),
  };
}

export function prepareRichMarkdownEdit(input: {
  sourceType: "git" | "native";
  baseMarkdown: string;
  expectedBaseHash: string;
  blockEdits: Array<{ blockIndex: number; replacementMarkdown: string }>;
}): MarkdownEditProposal {
  if (input.sourceType !== "git") {
    throw new FoundationServiceError("CONFLICT", "Rich Markdown edits only accept Git-backed page sources.");
  }
  const analysis = analyzeMarkdown(input.baseMarkdown);
  if (analysis.sourceHash !== input.expectedBaseHash) {
    throw new FoundationServiceError("REVISION_CONFLICT", "Markdown changed after the rich edit was prepared.", {
      expectedRevision: input.expectedBaseHash,
      currentRevision: analysis.sourceHash,
    });
  }
  if (analysis.mode !== "rich") {
    throw new FoundationServiceError("CONFLICT", "Markdown requires source-only editing.", { warnings: analysis.warnings });
  }
  const indexes = new Set<number>();
  const replacements: Array<{ block: MarkdownBlock; replacement: string }> = [];
  for (const edit of input.blockEdits) {
    if (!Number.isSafeInteger(edit.blockIndex) || indexes.has(edit.blockIndex)) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Rich edit block indexes must be unique integers.");
    }
    indexes.add(edit.blockIndex);
    const block = analysis.blocks[edit.blockIndex];
    if (!block) throw new FoundationServiceError("NOT_FOUND", "Markdown block was not found.");
    if (block.protected) {
      throw new FoundationServiceError("CONFLICT", "Protected Markdown blocks cannot be changed from rich mode.", {
        blockIndex: edit.blockIndex,
        protectedReason: block.protectedReason,
      });
    }
    const replacementAnalysis = analyzeMarkdown(edit.replacementMarkdown);
    if (replacementAnalysis.mode !== "rich" || replacementAnalysis.blocks.some((item) => item.protected)) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Replacement Markdown must contain only supported rich blocks.");
    }
    replacements.push({ block, replacement: edit.replacementMarkdown });
  }
  replacements.sort((left, right) => right.block.start - left.block.start);
  let candidate = input.baseMarkdown;
  for (const replacement of replacements) {
    candidate = candidate.slice(0, replacement.block.start)
      + replacement.replacement
      + candidate.slice(replacement.block.end);
  }
  const candidateAnalysis = analyzeMarkdown(candidate);
  if (candidateAnalysis.mode !== "rich") {
    throw new FoundationServiceError("CONFLICT", "The edited Markdown did not pass the round-trip parser gate.", {
      warnings: candidateAnalysis.warnings,
    });
  }
  const baseProtected = analysis.blocks.filter((block) => block.protected).map((block) => digest(block.raw));
  const candidateProtected = candidateAnalysis.blocks.filter((block) => block.protected).map((block) => digest(block.raw));
  const protectedBlocksPreserved = baseProtected.length === candidateProtected.length
    && baseProtected.every((value, index) => candidateProtected[index] === value);
  if (!protectedBlocksPreserved) {
    throw new FoundationServiceError("CONFLICT", "The rich edit changed protected Markdown source.");
  }
  return {
    baseHash: analysis.sourceHash,
    candidateHash: candidateAnalysis.sourceHash,
    candidateMarkdown: candidate,
    changedBlocks: replacements.reverse().map(({ block, replacement }) => ({
      index: block.index,
      beforeHash: digest(block.raw),
      afterHash: digest(replacement),
    })),
    protectedBlocksPreserved,
    renderedHtml: candidateAnalysis.renderedHtml,
    warnings: candidateAnalysis.warnings,
  };
}

function inlineText(token: MarkedToken): string {
  if (typeof token.text === "string") return token.text;
  if (Array.isArray(token.tokens)) return token.tokens.map((child) => inlineText(child as MarkedToken)).join("");
  return "";
}

export function markdownToNativeDocument(source: string): ProseMirrorNode {
  const analysis = analyzeMarkdown(source);
  const content: ProseMirrorNode[] = analysis.blocks
    .filter((block) => block.type !== "space" && block.raw.trim().length > 0)
    .map((block) => {
      if (block.protected) {
        return { type: "code_block", attrs: { protected_raw: true, source_type: block.type }, content: [{ type: "text", text: block.raw }] };
      }
      const token = (marked.lexer(block.raw, { gfm: true }) as unknown as MarkedToken[])[0];
      const text = token ? inlineText(token) : block.raw.trim();
      if (block.type === "heading") {
        const depth = typeof token?.depth === "number" ? token.depth : 1;
        return { type: "heading", attrs: { level: depth }, content: text ? [{ type: "text", text }] : [] };
      }
      if (block.type === "code") {
        return { type: "code_block", attrs: { language: null }, content: [{ type: "text", text: text || block.raw }] };
      }
      if (block.type === "blockquote") {
        return { type: "blockquote", content: [{ type: "paragraph", content: text ? [{ type: "text", text }] : [] }] };
      }
      return { type: "paragraph", content: text ? [{ type: "text", text }] : [] };
    });
  return { type: "doc", content };
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`*_[\]<>])/g, "\\$1");
}

export function nativeDocumentToMarkdown(document: ProseMirrorNode): string {
  if (document.type !== "doc") throw new FoundationServiceError("VALIDATION_FAILED", "Native document requires a doc root.");
  const serializeInline = (node: ProseMirrorNode): string => {
    if (node.type === "text") return escapeMarkdownText(node.text ?? "");
    return (node.content ?? []).map(serializeInline).join("");
  };
  const serialize = (node: ProseMirrorNode): string => {
    if (node.attrs?.protected_raw === true && node.content?.[0]?.text) return node.content[0].text;
    if (node.type === "heading") {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.level ?? 1)));
      return `${"#".repeat(level)} ${serializeInline(node)}\n\n`;
    }
    if (node.type === "paragraph") return `${serializeInline(node)}\n\n`;
    if (node.type === "blockquote") {
      return serializeInline(node).split("\n").map((line) => `> ${line}`).join("\n") + "\n\n";
    }
    if (node.type === "code_block") {
      const language = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      return `\`\`\`${language}\n${node.content?.map((child) => child.text ?? "").join("") ?? ""}\n\`\`\`\n\n`;
    }
    if (node.type === "bullet_list" || node.type === "ordered_list") {
      return (node.content ?? []).map((item, index) => `${node.type === "ordered_list" ? `${index + 1}.` : "-"} ${serializeInline(item)}`).join("\n") + "\n\n";
    }
    return `${serializeInline(node)}\n\n`;
  };
  return (document.content ?? []).map(serialize).join("").replace(/\n{3,}$/g, "\n");
}

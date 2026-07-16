import { describe, expect, it } from "vitest";
import {
  analyzeMarkdown,
  markdownToNativeDocument,
  nativeDocumentToMarkdown,
  prepareRichMarkdownEdit,
} from "./markdown-roundtrip";

describe("rich Markdown round-trip gate", () => {
  it("accepts the supported GFM block subset", () => {
    const source = [
      "# Heading",
      "",
      "Paragraph with **strong**, *emphasis*, ~~strike~~, and [link](https://example.test).",
      "",
      "- [x] task",
      "- item",
      "",
      "> quote",
      "",
      "```ts",
      "const value = 1;",
      "```",
      "",
      "| A | B |",
      "| - | - |",
      "| 1 | 2 |",
      "",
    ].join("\n");
    const analysis = analyzeMarkdown(source);
    expect(analysis.mode).toBe("rich");
    expect(analysis.blocks.some((block) => block.type === "table")).toBe(true);
    expect(analysis.renderedHtml).toContain("<table>");
  });

  it("protects front matter and raw HTML while allowing neighboring rich blocks", () => {
    const source = "---\ntitle: Protected\n---\n\n# Editable\n\n<div data-x=\"1\">raw</div>\n";
    const analysis = analyzeMarkdown(source);
    expect(analysis.mode).toBe("rich");
    expect(analysis.blocks.filter((block) => block.protected).map((block) => block.protectedReason))
      .toEqual(expect.arrayContaining(["front_matter", "raw_html"]));
    const heading = analysis.blocks.find((block) => block.type === "heading")!;
    const proposal = prepareRichMarkdownEdit({
      sourceType: "git",
      baseMarkdown: source,
      expectedBaseHash: analysis.sourceHash,
      blockEdits: [{ blockIndex: heading.index, replacementMarkdown: "# Changed\n\n" }],
    });
    expect(proposal.protectedBlocksPreserved).toBe(true);
    expect(proposal.candidateMarkdown).toContain("title: Protected");
    expect(proposal.candidateMarkdown).toContain("<div data-x=\"1\">raw</div>");
    expect(proposal.candidateMarkdown).toContain("# Changed");
  });

  it("protects MDX and directives", () => {
    const source = "# Intro\n\n<Component value={1} />\n\n:::note\nraw directive\n:::\n";
    const analysis = analyzeMarkdown(source);
    expect(analysis.blocks.some((block) => block.protectedReason === "mdx_or_jsx")).toBe(true);
    expect(analysis.blocks.some((block) => block.protectedReason === "custom_directive")).toBe(true);
  });

  it("forces source-only mode for malformed fenced content", () => {
    const analysis = analyzeMarkdown("# Broken\n\n```ts\nconst value = 1;\n");
    expect(analysis.mode).toBe("source_only");
    expect(analysis.warnings).toContain("unbalanced_fenced_code");
  });

  it("rejects stale bases and direct edits to protected blocks", () => {
    const source = "---\ntitle: Stable\n---\n\n# Heading\n";
    const analysis = analyzeMarkdown(source);
    expect(() => prepareRichMarkdownEdit({
      sourceType: "git",
      baseMarkdown: source,
      expectedBaseHash: "0".repeat(64),
      blockEdits: [],
    })).toThrow(/changed after/);
    const protectedBlock = analysis.blocks.find((block) => block.protected)!;
    expect(() => prepareRichMarkdownEdit({
      sourceType: "git",
      baseMarkdown: source,
      expectedBaseHash: analysis.sourceHash,
      blockEdits: [{ blockIndex: protectedBlock.index, replacementMarkdown: "---\ntitle: Changed\n---\n" }],
    })).toThrow(/Protected Markdown/);
  });

  it("preserves Unicode through import and export", () => {
    const source = "# नमस्ते 🌏\n\nCafé — 東京\n";
    const native = markdownToNativeDocument(source);
    const exported = nativeDocumentToMarkdown(native);
    expect(exported).toContain("नमस्ते 🌏");
    expect(exported).toContain("Café — 東京");
  });

  it("rejects native sources at the Markdown mutation boundary", () => {
    const source = "# Heading\n";
    const analysis = analyzeMarkdown(source);
    expect(() => prepareRichMarkdownEdit({
      sourceType: "native",
      baseMarkdown: source,
      expectedBaseHash: analysis.sourceHash,
      blockEdits: [],
    })).toThrow(/only accept Git-backed/);
  });
});

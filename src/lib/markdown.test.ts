import { describe, expect, it } from "vitest";
import { parseMarkdown } from "./markdown";

describe("parseMarkdown", () => {
  it("extracts a title, headings, and searchable text", () => {
    const parsed = parseMarkdown("# Safe notes\n\n## One thing\n\nA useful detail.", "notes.md");
    expect(parsed.title).toBe("Safe notes");
    expect(parsed.headings.map((heading) => heading.slug)).toEqual(["safe-notes", "one-thing"]);
    expect(parsed.extractedText).toContain("useful detail");
  });

  it("removes scripts, event handlers, and unsafe image URLs", () => {
    const parsed = parseMarkdown("# Safety\n<script>alert(1)</script>\n<img src=\"file:///etc/passwd\" onerror=\"alert(2)\">", "unsafe.md");
    expect(parsed.renderedHtml).not.toContain("script");
    expect(parsed.renderedHtml).not.toContain("onerror");
    expect(parsed.renderedHtml).not.toContain("file:");
  });

  it("gives duplicate headings stable unique slugs", () => {
    const parsed = parseMarkdown("# Plan\n## Next\n## Next", "plan.md");
    expect(parsed.headings.map((heading) => heading.slug)).toEqual(["plan", "next", "next-1"]);
  });
});

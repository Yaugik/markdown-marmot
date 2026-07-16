import { createHash } from "node:crypto";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";

export type ParsedHeading = { level: number; text: string; slug: string; position: number };

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, "-").replace(/-+/g, "-");
}

export function parseMarkdown(markdown: string, fallbackTitle: string) {
  const headings: ParsedHeading[] = [];
  const seen = new Map<string, number>();
  const renderer = new marked.Renderer();
  renderer.heading = ({ text, depth }) => {
    const base = slugify(sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} })) || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const slug = count ? `${base}-${count}` : base;
    headings.push({ level: depth, text: sanitizeHtml(text, { allowedTags: [], allowedAttributes: {} }), slug, position: headings.length });
    return `<h${depth} id="${slug}">${text}</h${depth}>`;
  };
  const rawHtml = marked.parse(markdown, { renderer, gfm: true, breaks: false }) as string;
  const renderedHtml = sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "h1", "h2"]),
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, "*": ["id"], a: ["href", "title"], code: ["class"] },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: { img: () => ({ tagName: "span", attribs: {}, text: "[Image hidden for safety]" }) },
  });
  const extractedText = sanitizeHtml(rawHtml, { allowedTags: [], allowedAttributes: {} }).replace(/\s+/g, " ").trim();
  const title = headings.find((heading) => heading.level === 1)?.text || fallbackTitle.replace(/\.(md|markdown)$/i, "");
  return {
    title,
    headings,
    renderedHtml,
    extractedText,
    contentHash: createHash("sha256").update(markdown).digest("hex"),
  };
}

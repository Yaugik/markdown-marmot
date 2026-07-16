import { FoundationServiceError } from "@/services/foundation/errors";

export function structuredScheduleDocument(
  value: unknown,
  label = "Scheduling body",
): { document: Record<string, unknown>; plainText: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FoundationServiceError("VALIDATION_FAILED", `${label} must be a structured document.`);
  }
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > 1024 * 1024) {
    throw new FoundationServiceError("VALIDATION_FAILED", `${label} must be at most 1 MiB.`);
  }
  const root = value as Record<string, unknown>;
  if (root.type !== "doc") {
    throw new FoundationServiceError("VALIDATION_FAILED", `${label} requires a doc root.`);
  }
  let nodes = 0;
  const text: string[] = [];
  const visit = (node: unknown, depth: number) => {
    if (depth > 100 || ++nodes > 10_000 || !node || typeof node !== "object" || Array.isArray(node)) {
      throw new FoundationServiceError("VALIDATION_FAILED", `${label} is not a valid structured document.`);
    }
    const item = node as Record<string, unknown>;
    if (typeof item.type !== "string" || !item.type) {
      throw new FoundationServiceError("VALIDATION_FAILED", `${label} nodes require a type.`);
    }
    if (item.text !== undefined) {
      if (typeof item.text !== "string") {
        throw new FoundationServiceError("VALIDATION_FAILED", `${label} text values must be strings.`);
      }
      text.push(item.text);
    }
    if (item.content !== undefined) {
      if (!Array.isArray(item.content)) {
        throw new FoundationServiceError("VALIDATION_FAILED", `${label} node content must be an array.`);
      }
      for (const child of item.content) visit(child, depth + 1);
    }
    if (["paragraph", "heading", "blockquote", "code_block", "list_item"].includes(String(item.type))) {
      text.push("\n");
    }
  };
  visit(root, 0);
  const plainText = text.join("").replace(/\n{3,}/g, "\n\n").trim();
  if (plainText.length > 100_000) {
    throw new FoundationServiceError("VALIDATION_FAILED", `${label} text must be at most 100,000 characters.`);
  }
  return { document: root, plainText };
}

export function emptyScheduleDocument() {
  return { document: { type: "doc", content: [] }, plainText: "" };
}

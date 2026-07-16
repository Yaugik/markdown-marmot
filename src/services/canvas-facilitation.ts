import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { readCanvasRegion, type CanvasRegionBounds } from "@/services/canvas-regions";
import type { CanvasElement } from "@/services/canvas-scenes";

export type WorkshopItem = {
  elementId: string;
  text: string;
  frameId: string | null;
  voteCount: number;
};
export type WorkshopOutput = {
  canvasId: string;
  canvasRevision: number;
  title: string;
  topics: WorkshopItem[];
  decisions: WorkshopItem[];
  actionCandidates: WorkshopItem[];
  notes: WorkshopItem[];
  accessibleOutline: Array<{ elementId: string; kind: string; label: string }>;
  markdown: string;
  truncated: boolean;
};

function text(element: CanvasElement) {
  for (const candidate of [element.content.text, element.content.title, element.content.label]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 2000);
  }
  return "";
}

function frameId(element: CanvasElement) {
  return typeof element.content.frameId === "string" ? element.content.frameId : null;
}

function category(element: CanvasElement) {
  const value = typeof element.content.category === "string" ? element.content.category.toLowerCase() : "";
  const intent = typeof element.content.intent === "string" ? element.content.intent.toLowerCase() : "";
  const combined = `${value} ${intent}`;
  if (combined.includes("decision")) return "decision" as const;
  if (combined.includes("action") || combined.includes("todo") || combined.includes("task")) return "action" as const;
  if (combined.includes("topic") || combined.includes("theme")) return "topic" as const;
  return "note" as const;
}

function markdownSection(title: string, items: WorkshopItem[]) {
  if (!items.length) return [];
  return [`## ${title}`, "", ...items.map((item) => `- ${item.text}${item.voteCount ? ` — ${item.voteCount} vote${item.voteCount === 1 ? "" : "s"}` : ""}`), ""];
}

export async function prepareWorkshopOutput(
  input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    bounds: CanvasRegionBounds;
    title?: string;
  },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<WorkshopOutput> {
  const region = await readCanvasRegion({ ...input, bounds: input.bounds, maxElements: 500 }, principalId, pool);
  const voteCounts = new Map<string, number>();
  for (const element of region.elements) {
    if (element.kind !== "vote") continue;
    const target = typeof element.content.targetElementId === "string" ? element.content.targetElementId : null;
    if (target) voteCounts.set(target, (voteCounts.get(target) ?? 0) + 1);
  }
  const groups: Record<"topic" | "decision" | "action" | "note", WorkshopItem[]> = {
    topic: [], decision: [], action: [], note: [],
  };
  for (const element of region.elements) {
    if (!(["sticky", "text", "entity_card"] as string[]).includes(element.kind)) continue;
    const value = text(element);
    if (!value) continue;
    groups[category(element)].push({
      elementId: element.id,
      text: value,
      frameId: frameId(element),
      voteCount: voteCounts.get(element.id) ?? 0,
    });
  }
  for (const items of Object.values(groups)) {
    items.sort((a, b) => b.voteCount - a.voteCount || a.text.localeCompare(b.text) || a.elementId.localeCompare(b.elementId));
  }
  const title = input.title?.trim().slice(0, 200) || `${region.canvas.title} workshop output`;
  const lines = [
    `# ${title}`,
    "",
    `Source Canvas: ${region.canvas.id}`,
    `Source revision: ${region.canvas.revision}`,
    "",
    ...markdownSection("Topics", groups.topic),
    ...markdownSection("Decisions", groups.decision),
    ...markdownSection("Action candidates", groups.action),
    ...markdownSection("Notes", groups.note),
  ];
  return {
    canvasId: region.canvas.id,
    canvasRevision: region.canvas.revision,
    title,
    topics: groups.topic,
    decisions: groups.decision,
    actionCandidates: groups.action,
    notes: groups.note,
    accessibleOutline: region.accessibleOutline.map((item) => ({ elementId: item.elementId, kind: item.kind, label: item.label })),
    markdown: `${lines.join("\n").trim()}\n`,
    truncated: region.truncated,
  };
}

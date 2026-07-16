import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { FoundationServiceError } from "@/services/foundation/errors";
import { readCanvas, type CanvasElement } from "@/services/canvas-scenes";
import { readCanvasRegion, type CanvasRegionBounds } from "@/services/canvas-regions";

export type CanvasExportFormat = "markdown" | "json";
export type CanvasAccessibleExport = {
  canvasId: string;
  canvasRevision: number;
  format: CanvasExportFormat;
  mediaType: string;
  content: string;
  contentLength: number;
};

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function elementLabel(element: CanvasElement) {
  return text(element.content.title)
    || text(element.content.text)
    || text(element.content.label)
    || element.kind.replaceAll("_", " ");
}

function markdown(canvas: { id: string; title: string; revision: number }, elements: CanvasElement[]) {
  const lines = [`# ${canvas.title}`, "", `Canvas revision: ${canvas.revision}`, ""];
  const ordered = [...elements].sort((a, b) => {
    const ay = typeof a.geometry.y === "number" ? a.geometry.y : 0;
    const by = typeof b.geometry.y === "number" ? b.geometry.y : 0;
    const ax = typeof a.geometry.x === "number" ? a.geometry.x : 0;
    const bx = typeof b.geometry.x === "number" ? b.geometry.x : 0;
    return ay - by || ax - bx || a.zIndex - b.zIndex || a.id.localeCompare(b.id);
  });
  for (const element of ordered) {
    if (["connector", "comment", "vote"].includes(element.kind)) continue;
    const suffix = element.entityType && element.entityId
      ? ` (${element.entityType.replaceAll("_", " ")} ${element.entityId})`
      : "";
    lines.push(`- **${element.kind.replaceAll("_", " ")}**${suffix}: ${elementLabel(element)}`);
  }
  const connectors = ordered.filter((element) => element.kind === "connector");
  if (connectors.length) {
    lines.push("", "## Visible connectors", "");
    for (const connector of connectors) {
      const from = text(connector.content.fromElementId);
      const to = text(connector.content.toElementId);
      const relation = text(connector.content.promotedRelationshipId);
      lines.push(`- ${from} → ${to}${relation ? ` (relationship ${relation})` : ""}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function exportCanvasAccessible(
  input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    format: CanvasExportFormat;
    bounds?: CanvasRegionBounds;
  },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<CanvasAccessibleExport> {
  const projection = input.bounds
    ? await readCanvasRegion({ ...input, bounds: input.bounds, maxElements: 500 }, principalId, pool)
    : null;
  const scene = projection
    ? { ...projection.canvas, elements: projection.elements }
    : await readCanvas({ workspaceId: input.workspaceId, projectId: input.projectId, canvasId: input.canvasId }, principalId, pool);

  const content = input.format === "json"
    ? `${JSON.stringify({
      canvas: {
        id: scene.id,
        title: scene.title,
        revision: scene.revision,
        sceneVersion: scene.sceneVersion,
      },
      bounds: input.bounds ?? null,
      elements: scene.elements,
    }, null, 2)}\n`
    : markdown(scene, scene.elements);
  const contentLength = Buffer.byteLength(content);
  if (contentLength > 2 * 1024 * 1024) {
    throw new FoundationServiceError("CONFLICT", "Canvas export exceeds the two MiB response boundary; export a smaller region.");
  }
  return {
    canvasId: scene.id,
    canvasRevision: scene.revision,
    format: input.format,
    mediaType: input.format === "json" ? "application/json" : "text/markdown; charset=utf-8",
    content,
    contentLength,
  };
}

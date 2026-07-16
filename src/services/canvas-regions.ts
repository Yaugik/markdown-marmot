import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { FoundationServiceError } from "@/services/foundation/errors";
import { readCanvas, type CanvasElement, type CanvasScene } from "@/services/canvas-scenes";

export type CanvasRegionBounds = { x: number; y: number; width: number; height: number };
export type AccessibleCanvasItem = {
  elementId: string;
  kind: CanvasElement["kind"];
  label: string;
  entityType: CanvasElement["entityType"];
  entityId: string | null;
  position: { x: number; y: number };
};
export type CanvasRegion = {
  canvas: Omit<CanvasScene, "elements">;
  bounds: CanvasRegionBounds;
  elements: CanvasElement[];
  accessibleOutline: AccessibleCanvasItem[];
  truncated: boolean;
};

type Box = { x: number; y: number; width: number; height: number };

function finite(value: number, label: string) {
  if (!Number.isFinite(value) || Math.abs(value) > 10_000_000) {
    throw new FoundationServiceError("VALIDATION_FAILED", `${label} is outside the supported Canvas coordinate range.`);
  }
  return value;
}

export function normalizeCanvasRegion(value: CanvasRegionBounds): CanvasRegionBounds {
  const x = finite(value.x, "Region x");
  const y = finite(value.y, "Region y");
  const width = finite(value.width, "Region width");
  const height = finite(value.height, "Region height");
  if (width <= 0 || height <= 0) {
    throw new FoundationServiceError("VALIDATION_FAILED", "Canvas region width and height must be positive.");
  }
  return { x, y, width, height };
}

function numberValue(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function box(element: CanvasElement): Box {
  return {
    x: numberValue(element.geometry.x, 0),
    y: numberValue(element.geometry.y, 0),
    width: Math.max(1, numberValue(element.geometry.width, 1)),
    height: Math.max(1, numberValue(element.geometry.height, 1)),
  };
}

function intersects(left: Box, right: Box) {
  return left.x < right.x + right.width
    && left.x + left.width > right.x
    && left.y < right.y + right.height
    && left.y + left.height > right.y;
}

function connectorEndpoints(element: CanvasElement) {
  return {
    from: typeof element.content.fromElementId === "string" ? element.content.fromElementId : null,
    to: typeof element.content.toElementId === "string" ? element.content.toElementId : null,
  };
}

function targetElementId(element: CanvasElement) {
  return typeof element.content.targetElementId === "string" ? element.content.targetElementId : null;
}

function label(element: CanvasElement) {
  for (const candidate of [element.content.title, element.content.text, element.content.label, element.content.name]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 240);
  }
  if (element.kind === "entity_card" && element.entityType) return `${element.entityType.replaceAll("_", " ")} card`;
  return element.kind.replaceAll("_", " ");
}

export async function readCanvasRegion(
  input: {
    workspaceId: string;
    projectId: string;
    canvasId: string;
    bounds: CanvasRegionBounds;
    maxElements?: number;
  },
  principalId: string,
  pool: Pool = postgresPool(),
): Promise<CanvasRegion> {
  const bounds = normalizeCanvasRegion(input.bounds);
  const maxElements = Math.max(1, Math.min(input.maxElements ?? 250, 500));
  const scene = await readCanvas({
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    canvasId: input.canvasId,
  }, principalId, pool);

  const visible = new Map<string, CanvasElement>();
  const spatial = scene.elements
    .filter((element) => !["connector", "comment", "vote"].includes(element.kind))
    .filter((element) => intersects(box(element), bounds))
    .sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id));

  let truncated = spatial.length > maxElements;
  for (const element of spatial.slice(0, maxElements)) visible.set(element.id, element);

  for (const element of scene.elements) {
    let eligible = false;
    if (element.kind === "connector") {
      const endpoints = connectorEndpoints(element);
      eligible = Boolean(endpoints.from && endpoints.to && visible.has(endpoints.from) && visible.has(endpoints.to));
    } else if (element.kind === "comment" || element.kind === "vote") {
      const target = targetElementId(element);
      eligible = Boolean(target && visible.has(target));
    }
    if (!eligible) continue;
    if (visible.size >= maxElements) {
      truncated = true;
      continue;
    }
    visible.set(element.id, element);
  }

  const elements = [...visible.values()].sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id));
  const accessibleOutline = elements
    .filter((element) => !["connector", "comment", "vote"].includes(element.kind))
    .map((element) => {
      const geometry = box(element);
      return {
        elementId: element.id,
        kind: element.kind,
        label: label(element),
        entityType: element.entityType,
        entityId: element.entityId,
        position: { x: geometry.x, y: geometry.y },
      };
    })
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x || a.elementId.localeCompare(b.elementId));

  const { elements: _allElements, ...canvas } = scene;
  return { canvas, bounds, elements, accessibleOutline, truncated };
}

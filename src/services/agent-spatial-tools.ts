import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { FoundationServiceError } from "@/services/foundation/errors";
import type { MutationContext } from "@/services/foundation/types";
import { authorizeAgentCanvasCapability, authorizeAgentEntityRead, authorizeAgentProjectCapability, type AgentActorChain } from "@/services/agent-spatial-access";
import { executeClusteredGraph, type GraphClusterMode } from "@/services/graph-clustering";
import { readCanvasRegion, type CanvasRegion, type CanvasRegionBounds } from "@/services/canvas-regions";
import { createCanvas, applyCanvasCommand, readCanvas } from "@/services/canvas-scenes";
import {
  prepareConnectorPromotion,
  prepareRegionOrganization,
  prepareStickyConversion,
  readCanvasActionPreview,
  type OrganizeMode,
  type StickyConversionTarget,
} from "@/services/canvas-action-previews";
import { executeCanvasActionPreview } from "@/services/canvas-authoritative-actions";
import { prepareWorkshopOutput, type WorkshopOutput } from "@/services/canvas-facilitation";
import type { GraphEntityRef } from "@/services/graph-explorer";

export type AgentSpatialToolRequest =
  | { tool: "expand_graph"; roots: GraphEntityRef[]; mode?: GraphClusterMode; depth?: number; nodeLimit?: number; edgeLimit?: number }
  | { tool: "read_canvas_region"; canvasId: string; bounds: CanvasRegionBounds; maxElements?: number }
  | { tool: "create_canvas"; title: string; visibility?: "private" | "project" }
  | { tool: "add_entity_to_canvas"; canvasId: string; entity: GraphEntityRef; geometry?: Record<string, unknown>; content?: Record<string, unknown> }
  | { tool: "create_sticky"; canvasId: string; text: string; geometry?: Record<string, unknown>; category?: string }
  | { tool: "connect_canvas_nodes"; canvasId: string; fromElementId: string; toElementId: string; label?: string }
  | { tool: "organize_canvas_region"; canvasId: string; elementIds: string[]; mode: OrganizeMode; gap?: number; columns?: number }
  | { tool: "promote_connector_to_relationship"; canvasId: string; connectorElementId: string; relationshipTypeId: string }
  | { tool: "convert_sticky"; canvasId: string; stickyElementId: string; target: StickyConversionTarget; addEntityCard?: boolean }
  | { tool: "execute_canvas_action"; previewId: string }
  | { tool: "prepare_workshop_output"; canvasId: string; bounds: CanvasRegionBounds; title?: string };

export type AgentSpatialToolResult = {
  tool: AgentSpatialToolRequest["tool"];
  riskLevel: "R0" | "R1" | "R2";
  data: unknown;
  warnings: string[];
  permissions: { actor: string; authorizer: string; intersectionApplied: true };
  suggestedNextActions: string[];
};

const key = (value: { type: string; id: string }) => `${value.type}:${value.id}`;

function actorChain(scope: { workspaceId: string; projectId: string }, context: MutationContext): AgentActorChain {
  if (!context.authorizingPrincipalId || context.authorizingPrincipalId === context.actorPrincipalId) {
    throw new FoundationServiceError("CAPABILITY_DENIED", "Agent spatial tools require a distinct human authorizer.");
  }
  return {
    ...scope,
    agentPrincipalId: context.actorPrincipalId,
    authorizingPrincipalId: context.authorizingPrincipalId,
  };
}

function result(
  request: AgentSpatialToolRequest,
  chain: AgentActorChain,
  data: unknown,
  riskLevel: AgentSpatialToolResult["riskLevel"],
  suggestedNextActions: string[] = [],
  warnings: string[] = [],
): AgentSpatialToolResult {
  return {
    tool: request.tool,
    riskLevel,
    data,
    warnings,
    permissions: { actor: chain.agentPrincipalId, authorizer: chain.authorizingPrincipalId, intersectionApplied: true },
    suggestedNextActions,
  };
}

function intersectRegions(agent: CanvasRegion, authorizer: CanvasRegion): CanvasRegion {
  const allowed = new Set(authorizer.elements.map((element) => element.id));
  const elements = agent.elements.filter((element) => allowed.has(element.id));
  const elementIds = new Set(elements.map((element) => element.id));
  const filtered = elements.filter((element) => {
    if (element.kind === "connector") {
      const from = typeof element.content.fromElementId === "string" ? element.content.fromElementId : null;
      const to = typeof element.content.toElementId === "string" ? element.content.toElementId : null;
      return Boolean(from && to && elementIds.has(from) && elementIds.has(to));
    }
    if (element.kind === "comment" || element.kind === "vote") {
      const target = typeof element.content.targetElementId === "string" ? element.content.targetElementId : null;
      return Boolean(target && elementIds.has(target));
    }
    return true;
  });
  const finalIds = new Set(filtered.map((element) => element.id));
  return {
    ...agent,
    elements: filtered,
    accessibleOutline: agent.accessibleOutline.filter((item) => finalIds.has(item.elementId)),
    truncated: agent.truncated || authorizer.truncated,
  };
}

function workshopMarkdown(output: Omit<WorkshopOutput, "markdown">) {
  const lines = [`# ${output.title}`, "", `Source Canvas: ${output.canvasId}`, `Source revision: ${output.canvasRevision}`, ""];
  for (const [title, items] of [["Topics",output.topics],["Decisions",output.decisions],["Action candidates",output.actionCandidates],["Notes",output.notes]] as const) {
    if (!items.length) continue;
    lines.push(`## ${title}`, "", ...items.map((item) => `- ${item.text}${item.voteCount ? ` — ${item.voteCount} vote${item.voteCount === 1 ? "" : "s"}` : ""}`), "");
  }
  return `${lines.join("\n").trim()}\n`;
}

async function intersectWorkshop(
  scope: { workspaceId: string; projectId: string },
  request: Extract<AgentSpatialToolRequest, { tool: "prepare_workshop_output" }>,
  chain: AgentActorChain,
  pool: Pool,
) {
  const input = { ...scope, canvasId: request.canvasId, bounds: request.bounds, title: request.title };
  const [agent, authorizer] = await Promise.all([
    prepareWorkshopOutput(input, chain.agentPrincipalId, pool),
    prepareWorkshopOutput(input, chain.authorizingPrincipalId, pool),
  ]);
  const allowed = new Set(authorizer.accessibleOutline.map((item) => item.elementId));
  const filtered = {
    ...agent,
    topics: agent.topics.filter((item) => allowed.has(item.elementId)),
    decisions: agent.decisions.filter((item) => allowed.has(item.elementId)),
    actionCandidates: agent.actionCandidates.filter((item) => allowed.has(item.elementId)),
    notes: agent.notes.filter((item) => allowed.has(item.elementId)),
    accessibleOutline: agent.accessibleOutline.filter((item) => allowed.has(item.elementId)),
    truncated: agent.truncated || authorizer.truncated,
  };
  return { ...filtered, markdown: workshopMarkdown(filtered) };
}

export async function executeAgentSpatialTool(
  scope: { workspaceId: string; projectId: string },
  request: AgentSpatialToolRequest,
  context: MutationContext,
  pool: Pool = postgresPool(),
): Promise<AgentSpatialToolResult> {
  const chain = actorChain(scope, context);

  if (request.tool === "expand_graph") {
    await authorizeAgentProjectCapability({ ...chain, capability: "graph.read" }, pool);
    for (const root of request.roots) await authorizeAgentEntityRead({ ...chain, entityType: root.type, entityId: root.id }, pool);
    const traversal = { depth: request.depth ?? 2, nodeLimit: request.nodeLimit ?? 250, edgeLimit: request.edgeLimit ?? 500 };
    const [agent, authorizer] = await Promise.all([
      executeClusteredGraph({ ...scope, rootEntities: request.roots, traversal, mode: request.mode }, chain.agentPrincipalId, pool),
      executeClusteredGraph({ ...scope, rootEntities: request.roots, traversal, mode: request.mode }, chain.authorizingPrincipalId, pool),
    ]);
    const authorizerNodes = new Set(authorizer.nodes.map(key));
    const nodes = agent.nodes.filter((node) => authorizerNodes.has(key(node)));
    const visibleNodes = new Set(nodes.map(key));
    const authorizerEdges = new Set(authorizer.edges.map((edge) => edge.id));
    const edges = agent.edges.filter((edge) => authorizerEdges.has(edge.id) && visibleNodes.has(key(edge.source)) && visibleNodes.has(key(edge.target)));
    const visibleEdges = new Set(edges.map((edge) => edge.id));
    const clusters = agent.clusters.map((cluster) => ({
      ...cluster,
      nodeIds: cluster.nodeIds.filter((id) => visibleNodes.has(id)),
      edgeIds: cluster.edgeIds.filter((id) => visibleEdges.has(id)),
    })).filter((cluster) => cluster.nodeIds.length > 0);
    return result(request, chain, {
      ...agent,
      nodes,
      edges,
      clusters,
      layout: agent.layout.filter((item) => visibleNodes.has(item.nodeId)),
      truncated: agent.truncated || authorizer.truncated,
    }, "R0", ["read_canvas_region", "save_graph_view"]);
  }

  if (request.tool === "read_canvas_region") {
    await authorizeAgentCanvasCapability({ ...chain, canvasId: request.canvasId, capability: "canvas.read" }, pool);
    const input = { ...scope, canvasId: request.canvasId, bounds: request.bounds, maxElements: request.maxElements };
    const [agent, authorizer] = await Promise.all([
      readCanvasRegion(input, chain.agentPrincipalId, pool),
      readCanvasRegion(input, chain.authorizingPrincipalId, pool),
    ]);
    return result(request, chain, intersectRegions(agent, authorizer), "R0", ["create_sticky", "organize_canvas_region", "prepare_workshop_output"]);
  }

  if (request.tool === "create_canvas") {
    await authorizeAgentProjectCapability({ ...chain, capability: "canvas.create" }, pool);
    const created = await createCanvas({ ...scope, title: request.title, visibility: request.visibility }, context, pool);
    return result(request, chain, created, "R1", ["add_entity_to_canvas", "create_sticky"]);
  }

  if (request.tool === "add_entity_to_canvas") {
    await authorizeAgentCanvasCapability({ ...chain, canvasId: request.canvasId, capability: "canvas.edit" }, pool);
    await authorizeAgentEntityRead({ ...chain, entityType: request.entity.type, entityId: request.entity.id }, pool);
    const scene = await readCanvas({ ...scope, canvasId: request.canvasId }, chain.agentPrincipalId, pool);
    const applied = await applyCanvasCommand({
      ...scope, canvasId: request.canvasId, expectedRevision: scene.revision,
      clientId: `agent:${chain.agentPrincipalId}`, clientSequence: Date.now(),
      command: { type: "element.create", element: { kind: "entity_card", entityType: request.entity.type, entityId: request.entity.id, geometry: request.geometry, content: request.content } },
    }, context, pool);
    return result(request, chain, applied, "R1", ["connect_canvas_nodes", "read_canvas_region"]);
  }

  if (request.tool === "create_sticky") {
    await authorizeAgentCanvasCapability({ ...chain, canvasId: request.canvasId, capability: "canvas.edit" }, pool);
    const text = request.text.trim();
    if (!text || text.length > 10_000) throw new FoundationServiceError("VALIDATION_FAILED", "Sticky text must contain 1 to 10,000 characters.");
    const scene = await readCanvas({ ...scope, canvasId: request.canvasId }, chain.agentPrincipalId, pool);
    const applied = await applyCanvasCommand({
      ...scope, canvasId: request.canvasId, expectedRevision: scene.revision,
      clientId: `agent:${chain.agentPrincipalId}`, clientSequence: Date.now(),
      command: { type: "element.create", element: { kind: "sticky", geometry: request.geometry, content: { text, category: request.category?.trim().slice(0,80) || undefined } } },
    }, context, pool);
    return result(request, chain, applied, "R1", ["convert_sticky", "organize_canvas_region"]);
  }

  if (request.tool === "connect_canvas_nodes") {
    await authorizeAgentCanvasCapability({ ...chain, canvasId: request.canvasId, capability: "canvas.edit" }, pool);
    const scene = await readCanvas({ ...scope, canvasId: request.canvasId }, chain.agentPrincipalId, pool);
    const ids = new Set(scene.elements.map((element) => element.id));
    if (!ids.has(request.fromElementId) || !ids.has(request.toElementId) || request.fromElementId === request.toElementId) {
      throw new FoundationServiceError("VALIDATION_FAILED", "Connector endpoints must be two distinct visible elements.");
    }
    const applied = await applyCanvasCommand({
      ...scope, canvasId: request.canvasId, expectedRevision: scene.revision,
      clientId: `agent:${chain.agentPrincipalId}`, clientSequence: Date.now(),
      command: { type: "element.create", element: { kind: "connector", content: { fromElementId: request.fromElementId, toElementId: request.toElementId, label: request.label?.trim().slice(0,240) || undefined } } },
    }, context, pool);
    return result(request, chain, applied, "R1", ["promote_connector_to_relationship"]);
  }

  if (request.tool === "organize_canvas_region") {
    await authorizeAgentCanvasCapability({ ...chain, canvasId: request.canvasId, capability: "canvas.edit" }, pool);
    const prepared = await prepareRegionOrganization({ ...scope, canvasId: request.canvasId, elementIds: request.elementIds, mode: request.mode, gap: request.gap, columns: request.columns }, context, pool);
    return result(request, chain, prepared, prepared.data.riskLevel === "R2" ? "R2" : "R1", [prepared.data.confirmationId ? "approve_canvas_action" : "execute_canvas_action"]);
  }

  if (request.tool === "promote_connector_to_relationship") {
    await authorizeAgentCanvasCapability({ ...chain, canvasId: request.canvasId, capability: "canvas.edit" }, pool);
    await authorizeAgentProjectCapability({ ...chain, capability: "relationship.edit" }, pool);
    const prepared = await prepareConnectorPromotion({ ...scope, canvasId: request.canvasId, connectorElementId: request.connectorElementId, relationshipTypeId: request.relationshipTypeId }, context, pool);
    return result(request, chain, prepared, "R1", ["execute_canvas_action"]);
  }

  if (request.tool === "convert_sticky") {
    await authorizeAgentCanvasCapability({ ...chain, canvasId: request.canvasId, capability: "canvas.edit" }, pool);
    const capability = request.target.entityType === "page" ? "page.create" : request.target.entityType === "issue" ? "issue.create" : "todo.create";
    await authorizeAgentProjectCapability({ ...chain, capability }, pool);
    const prepared = await prepareStickyConversion({ ...scope, canvasId: request.canvasId, stickyElementId: request.stickyElementId, target: request.target, addEntityCard: request.addEntityCard }, context, pool);
    return result(request, chain, prepared, "R1", ["execute_canvas_action"]);
  }

  if (request.tool === "execute_canvas_action") {
    const preview = await readCanvasActionPreview({ ...scope, previewId: request.previewId }, chain.agentPrincipalId, pool);
    await authorizeAgentCanvasCapability({ ...chain, canvasId: preview.canvasId, capability: "canvas.edit" }, pool);
    const executed = await executeCanvasActionPreview({ ...scope, previewId: request.previewId }, context, pool);
    return result(request, chain, executed, preview.riskLevel === "R2" ? "R2" : "R1", ["read_canvas_region"]);
  }

  await authorizeAgentCanvasCapability({ ...chain, canvasId: request.canvasId, capability: "canvas.read" }, pool);
  const output = await intersectWorkshop(scope, request, chain, pool);
  return result(request, chain, output, "R0", ["convert_sticky", "create_native_page"], output.truncated ? ["The selected region reached its element budget."] : []);
}

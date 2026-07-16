import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { FoundationServiceError } from "@/services/foundation/errors";
import type { MutationContext } from "@/services/foundation/types";
import {
  authorizeAgentCanvasCapability,
  authorizeAgentEntityRead,
  authorizeAgentProjectCapability,
  authorizeAgentTodoListEdit,
  type AgentActorChain,
} from "@/services/agent-spatial-access";
import { executeClusteredGraph, type GraphClusterMode } from "@/services/graph-clustering";
import { readCanvasRegion, type CanvasRegion, type CanvasRegionBounds } from "@/services/canvas-regions";
import { createCanvas, applyCanvasCommand, readCanvas, type CanvasScene } from "@/services/canvas-scenes";
import {
  prepareConnectorPromotion,
  prepareRegionOrganization,
  prepareStickyConversion,
  readCanvasActionPreview,
  type CanvasActionPreview,
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

async function readScenesForChain(
  scope: { workspaceId: string; projectId: string },
  canvasId: string,
  chain: AgentActorChain,
  pool: Pool,
): Promise<{ agent: CanvasScene; authorizer: CanvasScene }> {
  const [agent, authorizer] = await Promise.all([
    readCanvas({ ...scope, canvasId }, chain.agentPrincipalId, pool),
    readCanvas({ ...scope, canvasId }, chain.authorizingPrincipalId, pool),
  ]);
  return { agent, authorizer };
}

function assertVisibleElementIds(
  scenes: { agent: CanvasScene; authorizer: CanvasScene },
  elementIds: string[],
  label: string,
) {
  const ids = [...new Set(elementIds)];
  const agent = new Set(scenes.agent.elements.map((element) => element.id));
  const authorizer = new Set(scenes.authorizer.elements.map((element) => element.id));
  if (!ids.length || ids.some((id) => !agent.has(id) || !authorizer.has(id))) {
    throw new FoundationServiceError("CAPABILITY_DENIED", `${label} must be visible to both the agent and its authorizing human.`);
  }
}

function intersectRegions(agent: CanvasRegion, authorizer: CanvasRegion): CanvasRegion {
  const allowed = new Set(authorizer.elements.map((element) => element.id));
  const candidateElements = agent.elements.filter((element) => allowed.has(element.id));
  const candidateIds = new Set(candidateElements.map((element) => element.id));
  const elements = candidateElements.filter((element) => {
    if (element.kind === "connector") {
      const from = typeof element.content.fromElementId === "string" ? element.content.fromElementId : null;
      const to = typeof element.content.toElementId === "string" ? element.content.toElementId : null;
      return Boolean(from && to && candidateIds.has(from) && candidateIds.has(to));
    }
    if (element.kind === "comment" || element.kind === "vote") {
      const target = typeof element.content.targetElementId === "string" ? element.content.targetElementId : null;
      return Boolean(target && candidateIds.has(target));
    }
    return true;
  });
  const finalIds = new Set(elements.map((element) => element.id));
  return {
    ...agent,
    elements,
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

async function authorizePreviewTarget(
  scope: { workspaceId: string; projectId: string },
  preview: CanvasActionPreview,
  chain: AgentActorChain,
  pool: Pool,
) {
  if (preview.actionKind === "promote_connector") {
    await authorizeAgentProjectCapability({ ...chain, capability: "relationship.edit" }, pool);
    return;
  }
  if (preview.actionKind !== "convert_sticky") return;
  const target = preview.normalizedInput.target;
  if (!target || typeof target !== "object") throw new FoundationServiceError("CONFLICT", "Sticky conversion preview target is invalid.");
  const value = target as Record<string, unknown>;
  const entityType = value.entityType;
  const capability = entityType === "page" ? "page.create" : entityType === "issue" ? "issue.create" : entityType === "todo" ? "todo.create" : null;
  if (!capability) throw new FoundationServiceError("CONFLICT", "Sticky conversion preview target is invalid.");
  await authorizeAgentProjectCapability({ ...chain, capability }, pool);
  if (entityType === "todo") {
    if (typeof value.listId !== "string") throw new FoundationServiceError("CONFLICT", "To-do conversion preview is missing its list.");
    await authorizeAgentTodoListEdit({ ...chain, listId: value.listId }, pool);
  }
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
    if (request.visibility === "project") await authorizeAgentProjectCapability({ ...chain, capability: "project.update" }, pool);
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
    const scenes = await readScenesForChain(scope, request.canvasId, chain, pool);
    assertVisibleElementIds(scenes, [request.fromElementId,request.toElementId], "Connector endpoints");
    if (request.fromElementId === request.toElementId) throw new FoundationServiceError("VALIDATION_FAILED", "Connector endpoints must be distinct.");
    const applied = await applyCanvasCommand({
      ...scope, canvasId: request.canvasId, expectedRevision: scenes.agent.revision,
      clientId: `agent:${chain.agentPrincipalId}`, clientSequence: Date.now(),
      command: { type: "element.create", element: { kind: "connector", content: { fromElementId: request.fromElementId, toElementId: request.toElementId, label: request.label?.trim().slice(0,240) || undefined } } },
    }, context, pool);
    return result(request, chain, applied, "R1", ["promote_connector_to_relationship"]);
  }

  if (request.tool === "organize_canvas_region") {
    await authorizeAgentCanvasCapability({ ...chain, canvasId: request.canvasId, capability: "canvas.edit" }, pool);
    const scenes = await readScenesForChain(scope, request.canvasId, chain, pool);
    assertVisibleElementIds(scenes, request.elementIds, "Organization targets");
    const prepared = await prepareRegionOrganization({ ...scope, canvasId: request.canvasId, elementIds: request.elementIds, mode: request.mode, gap: request.gap, columns: request.columns }, context, pool);
    return result(request, chain, prepared, prepared.data.riskLevel === "R2" ? "R2" : "R1", [prepared.data.confirmationId ? "approve_canvas_action" : "execute_canvas_action"]);
  }

  if (request.tool === "promote_connector_to_relationship") {
    await authorizeAgentCanvasCapability({ ...chain, canvasId: request.canvasId, capability: "canvas.edit" }, pool);
    await authorizeAgentProjectCapability({ ...chain, capability: "relationship.edit" }, pool);
    const scenes = await readScenesForChain(scope, request.canvasId, chain, pool);
    assertVisibleElementIds(scenes, [request.connectorElementId], "Connector promotion target");
    const prepared = await prepareConnectorPromotion({ ...scope, canvasId: request.canvasId, connectorElementId: request.connectorElementId, relationshipTypeId: request.relationshipTypeId }, context, pool);
    return result(request, chain, prepared, "R1", ["execute_canvas_action"]);
  }

  if (request.tool === "convert_sticky") {
    await authorizeAgentCanvasCapability({ ...chain, canvasId: request.canvasId, capability: "canvas.edit" }, pool);
    const capability = request.target.entityType === "page" ? "page.create" : request.target.entityType === "issue" ? "issue.create" : "todo.create";
    await authorizeAgentProjectCapability({ ...chain, capability }, pool);
    if (request.target.entityType === "todo") await authorizeAgentTodoListEdit({ ...chain, listId: request.target.listId }, pool);
    const scenes = await readScenesForChain(scope, request.canvasId, chain, pool);
    assertVisibleElementIds(scenes, [request.stickyElementId], "Sticky conversion target");
    const prepared = await prepareStickyConversion({ ...scope, canvasId: request.canvasId, stickyElementId: request.stickyElementId, target: request.target, addEntityCard: request.addEntityCard }, context, pool);
    return result(request, chain, prepared, "R1", ["execute_canvas_action"]);
  }

  if (request.tool === "execute_canvas_action") {
    const [agentPreview, authorizerPreview] = await Promise.all([
      readCanvasActionPreview({ ...scope, previewId: request.previewId }, chain.agentPrincipalId, pool),
      readCanvasActionPreview({ ...scope, previewId: request.previewId }, chain.authorizingPrincipalId, pool),
    ]);
    if (agentPreview.actionDigest !== authorizerPreview.actionDigest || agentPreview.canvasId !== authorizerPreview.canvasId) {
      throw new FoundationServiceError("CAPABILITY_DENIED", "The preview is not shared by the complete actor chain.");
    }
    await authorizeAgentCanvasCapability({ ...chain, canvasId: agentPreview.canvasId, capability: "canvas.edit" }, pool);
    const scenes = await readScenesForChain(scope, agentPreview.canvasId, chain, pool);
    assertVisibleElementIds(scenes, agentPreview.sourceElementIds, "Canvas action sources");
    await authorizePreviewTarget(scope, agentPreview, chain, pool);
    const executed = await executeCanvasActionPreview({ ...scope, previewId: request.previewId }, context, pool);
    return result(request, chain, executed, agentPreview.riskLevel === "R2" ? "R2" : "R1", ["read_canvas_region"]);
  }

  await authorizeAgentCanvasCapability({ ...chain, canvasId: request.canvasId, capability: "canvas.read" }, pool);
  const output = await intersectWorkshop(scope, request, chain, pool);
  return result(request, chain, output, "R0", ["convert_sticky", "create_native_page"], output.truncated ? ["The selected region reached its element budget."] : []);
}

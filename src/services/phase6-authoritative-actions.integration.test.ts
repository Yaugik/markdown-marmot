import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { newFolioId } from "@/lib/folio-ids";
import { applyCanvasCommand, createCanvas, readCanvas } from "@/services/canvas-scenes";
import { approveCanvasActionPreview, prepareConnectorPromotion, prepareRegionOrganization, prepareStickyConversion } from "@/services/canvas-action-previews";
import { executeCanvasActionPreview } from "@/services/canvas-authoritative-actions";
import { readRelationshipDerivationRuns, rebuildDerivedRelationships } from "@/services/derived-relationships";
import { createProject, createWorkspace, provisionAuthenticatedHuman } from "@/services/foundation";
import { createNativePage, readNativePage } from "@/services/pages";
import { createRelationshipType, listEntityRelationships } from "@/services/typed-relationships";

const databaseUrl = process.env.DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const doc = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
function context(principalId: string, suffix: string, key: string, extra?: { authorizingPrincipalId?: string; source?: "api" | "agent" }) {
  return {
    actorPrincipalId: principalId,
    authorizingPrincipalId: extra?.authorizingPrincipalId,
    requestId: newFolioId(),
    traceId: `phase6-actions-${suffix}`,
    idempotencyKey: `${key}-${suffix}`,
    source: extra?.source ?? "api" as const,
  };
}

describeWithPostgres("Phase 6 authoritative Canvas actions", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  afterAll(async () => pool.end());

  it("promotes connectors, converts stickies, confirms broad organization, and rebuilds only derived edges", async () => {
    const suffix = newFolioId();
    const owner = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `phase6-actions-owner-${suffix}`,
      email: `phase6-actions-owner-${suffix}@example.test`,
      displayName: "Phase 6 Actions Owner",
    }, pool);
    const workspace = await createWorkspace({ name: "Phase 6 Actions", slug: `phase6-actions-${suffix}` }, context(owner.principalId,suffix,"workspace"), pool);
    const project = await createProject({ workspaceId: workspace.data.id, projectKey: "ACT", name: "Authoritative Canvas" }, context(owner.principalId,suffix,"project"), pool);
    const source = await createNativePage({ workspaceId: workspace.data.id, projectId: project.data.id, title: "Source page", content: doc("Source") }, context(owner.principalId,suffix,"source"), pool);
    const target = await createNativePage({ workspaceId: workspace.data.id, projectId: project.data.id, title: "Target page", content: doc("Target") }, context(owner.principalId,suffix,"target"), pool);
    const relationType = await createRelationshipType({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      typeKey: "supports",
      displayName: "Supports",
      sourceEntityTypes: ["page"],
      targetEntityTypes: ["page"],
    }, context(owner.principalId,suffix,"relationship-type"), pool);

    let scene = (await createCanvas({ workspaceId: workspace.data.id, projectId: project.data.id, title: "Workshop", visibility: "private" }, context(owner.principalId,suffix,"canvas"), pool)).data;
    const sourceCard = newFolioId();
    const targetCard = newFolioId();
    const connector = newFolioId();
    scene = (await applyCanvasCommand({ workspaceId: workspace.data.id, projectId: project.data.id, canvasId: scene.id, expectedRevision: scene.revision, clientId: "owner", clientSequence: 1, command: { type: "element.create", element: { id: sourceCard, kind: "entity_card", entityType: "page", entityId: source.data.id, content: { title: "Source page" }, geometry: { x: 10, y: 10, width: 220, height: 120 } } } }, context(owner.principalId,suffix,"source-card"), pool)).data;
    scene = (await applyCanvasCommand({ workspaceId: workspace.data.id, projectId: project.data.id, canvasId: scene.id, expectedRevision: scene.revision, clientId: "owner", clientSequence: 2, command: { type: "element.create", element: { id: targetCard, kind: "entity_card", entityType: "page", entityId: target.data.id, content: { title: "Target page" }, geometry: { x: 300, y: 10, width: 220, height: 120 } } } }, context(owner.principalId,suffix,"target-card"), pool)).data;
    scene = (await applyCanvasCommand({ workspaceId: workspace.data.id, projectId: project.data.id, canvasId: scene.id, expectedRevision: scene.revision, clientId: "owner", clientSequence: 3, command: { type: "element.create", element: { id: connector, kind: "connector", content: { fromElementId: sourceCard, toElementId: targetCard }, geometry: {} } } }, context(owner.principalId,suffix,"connector"), pool)).data;

    const promotion = await prepareConnectorPromotion({ workspaceId: workspace.data.id, projectId: project.data.id, canvasId: scene.id, connectorElementId: connector, relationshipTypeId: relationType.data.id }, context(owner.principalId,suffix,"promotion-preview"), pool);
    const promoted = await executeCanvasActionPreview({ workspaceId: workspace.data.id, projectId: project.data.id, previewId: promotion.data.id }, context(owner.principalId,suffix,"promotion-execute"), pool);
    const relationshipId = String(promoted.data.result?.relationshipId);
    expect(relationshipId).toMatch(/^[0-9a-f-]{36}$/i);
    expect((await listEntityRelationships({ workspaceId: workspace.data.id, projectId: project.data.id, entityType: "page", entityId: source.data.id }, owner.principalId, pool))).toEqual([
      expect.objectContaining({ id: relationshipId, provenance: "explicit", state: "accepted" }),
    ]);
    scene = await readCanvas({ workspaceId: workspace.data.id, projectId: project.data.id, canvasId: scene.id }, owner.principalId, pool);
    expect(scene.elements.find((element) => element.id === connector)?.content.promotedRelationshipId).toBe(relationshipId);

    const stickyIds: string[] = [];
    for (let index = 0; index < 11; index++) {
      const stickyId = newFolioId();
      stickyIds.push(stickyId);
      scene = (await applyCanvasCommand({
        workspaceId: workspace.data.id,
        projectId: project.data.id,
        canvasId: scene.id,
        expectedRevision: scene.revision,
        clientId: "owner",
        clientSequence: 10 + index,
        command: { type: "element.create", element: { id: stickyId, kind: "sticky", content: { text: index === 0 ? "Publish the workshop summary" : `Idea ${index}`, category: index === 0 ? "action" : "topic" }, geometry: { x: 20 + index * 15, y: 220 + index * 12, width: 220, height: 140 } } },
      }, context(owner.principalId,suffix,`sticky-${index}`), pool)).data;
    }

    const organization = await prepareRegionOrganization({ workspaceId: workspace.data.id, projectId: project.data.id, canvasId: scene.id, elementIds: stickyIds, mode: "grid", gap: 24, columns: 4 }, context(owner.principalId,suffix,"organization-preview"), pool);
    expect(organization.data).toMatchObject({ riskLevel: "R2", state: "pending" });
    await expect(executeCanvasActionPreview({ workspaceId: workspace.data.id, projectId: project.data.id, previewId: organization.data.id }, context(owner.principalId,suffix,"organization-too-early"), pool)).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    const approved = await approveCanvasActionPreview({ workspaceId: workspace.data.id, projectId: project.data.id, previewId: organization.data.id, expectedRevision: organization.data.revision }, context(owner.principalId,suffix,"organization-approve"), pool);
    const organized = await executeCanvasActionPreview({ workspaceId: workspace.data.id, projectId: project.data.id, previewId: organization.data.id }, context(owner.principalId,suffix,"organization-execute"), pool);
    expect(organized.data).toMatchObject({ state: "succeeded", riskLevel: "R2" });
    const confirmation = await pool.query<{ status: string }>(`SELECT status FROM action_confirmations WHERE id=$1`, [approved.data.confirmationId]);
    expect(confirmation.rows[0]?.status).toBe("consumed");

    const conversion = await prepareStickyConversion({ workspaceId: workspace.data.id, projectId: project.data.id, canvasId: scene.id, stickyElementId: stickyIds[0]!, target: { entityType: "page", title: "Workshop summary" }, addEntityCard: true }, context(owner.principalId,suffix,"conversion-preview"), pool);
    const converted = await executeCanvasActionPreview({ workspaceId: workspace.data.id, projectId: project.data.id, previewId: conversion.data.id }, context(owner.principalId,suffix,"conversion-execute"), pool);
    const convertedPageId = String(converted.data.result?.entityId);
    expect((await readNativePage({ workspaceId: workspace.data.id, projectId: project.data.id, pageId: convertedPageId }, owner.principalId, pool))).toMatchObject({ title: "Workshop summary", currentRevision: { plainText: "Publish the workshop summary" } });
    scene = await readCanvas({ workspaceId: workspace.data.id, projectId: project.data.id, canvasId: scene.id }, owner.principalId, pool);
    expect(scene.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "entity_card", entityType: "page", entityId: convertedPageId }),
    ]));

    const agentId = newFolioId();
    const memberRole = await pool.query<{ id: string }>(`SELECT id FROM role_templates WHERE workspace_id=$1 AND template_key='member'`, [workspace.data.id]);
    await pool.query(`INSERT INTO principals(id,kind,display_name,status) VALUES($1,'agent','Relationship synthesis agent','active')`, [agentId]);
    await pool.query(`INSERT INTO workspace_memberships(id,workspace_id,principal_id,role,status,invited_by_principal_id) VALUES($1,$2,$3,'member','active',$4)`, [newFolioId(),workspace.data.id,agentId,owner.principalId]);
    await pool.query(`INSERT INTO project_memberships(id,workspace_id,project_id,principal_id,role_template_id,status,invited_by_principal_id) VALUES($1,$2,$3,$4,$5,'active',$6)`, [newFolioId(),workspace.data.id,project.data.id,agentId,memberRole.rows[0]!.id,owner.principalId]);
    const agentContext = (key: string) => context(agentId,suffix,key,{ authorizingPrincipalId: owner.principalId, source: "agent" });
    const firstRun = await rebuildDerivedRelationships({ workspaceId: workspace.data.id, projectId: project.data.id, sourceKind: "agent_synthesis", source: { type: "page", id: source.data.id, revision: "revision-1" }, rebuildKey: "page-related-topics", candidates: [{ relationshipTypeId: relationType.data.id, target: { type: "page", id: target.data.id }, confidence: 0.8 }] }, agentContext("derive-1"), pool);
    const secondRun = await rebuildDerivedRelationships({ workspaceId: workspace.data.id, projectId: project.data.id, sourceKind: "agent_synthesis", source: { type: "page", id: source.data.id, revision: "revision-2" }, rebuildKey: "page-related-topics", candidates: [{ relationshipTypeId: relationType.data.id, target: { type: "page", id: convertedPageId }, confidence: 0.9 }] }, agentContext("derive-2"), pool);
    expect(secondRun.data.relationshipCount).toBe(1);
    const runs = await readRelationshipDerivationRuns({ workspaceId: workspace.data.id, projectId: project.data.id, sourceType: "page", sourceId: source.data.id }, owner.principalId, pool);
    expect(runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstRun.data.id, state: "superseded" }),
      expect.objectContaining({ id: secondRun.data.id, state: "succeeded", source: expect.objectContaining({ revision: "revision-2" }) }),
    ]));
    const relationships = await listEntityRelationships({ workspaceId: workspace.data.id, projectId: project.data.id, entityType: "page", entityId: source.data.id }, owner.principalId, pool);
    expect(relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: relationshipId, provenance: "explicit", state: "accepted" }),
      expect.objectContaining({ provenance: "derived", target: { type: "page", id: convertedPageId } }),
    ]));
    expect(relationships.some((item) => item.provenance === "derived" && item.target.id === target.data.id)).toBe(false);
  });
});

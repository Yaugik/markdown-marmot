import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { newFolioId } from "@/lib/folio-ids";
import { applyCanvasCommand, createCanvas, readCanvas } from "@/services/canvas-scenes";
import { createProject, createWorkspace, provisionAuthenticatedHuman } from "@/services/foundation";
import { executeGraphTraversal } from "@/services/graph-explorer";
import { executeMermaidImport, previewMermaidExport, previewMermaidImport } from "@/services/mermaid-interchange";
import { createNativePage } from "@/services/pages";
import { createRelationshipType, createTypedRelationship, listEntityRelationships } from "@/services/typed-relationships";

const databaseUrl=process.env.DATABASE_URL;
const describeWithPostgres=databaseUrl?describe:describe.skip;
const doc=(text:string)=>({type:"doc",content:[{type:"paragraph",content:[{type:"text",text}]}]});
function context(principalId:string,suffix:string,key:string){return{actorPrincipalId:principalId,requestId:newFolioId(),traceId:`phase6-${suffix}`,idempotencyKey:`${key}-${suffix}`,source:"api" as const};}

describeWithPostgres("Phase 6 graph and Canvas foundations",()=>{
  const pool=new Pool({connectionString:databaseUrl});
  afterAll(async()=>pool.end());

  it("omits unreadable relationship endpoints, Canvas cards, connectors, and Mermaid output",async()=>{
    const suffix=newFolioId();
    const owner=await provisionAuthenticatedHuman({issuer:"https://identity.example.test",subject:`phase6-owner-${suffix}`,email:`phase6-owner-${suffix}@example.test`,displayName:"Phase 6 Owner"},pool);
    const reader=await provisionAuthenticatedHuman({issuer:"https://identity.example.test",subject:`phase6-reader-${suffix}`,email:`phase6-reader-${suffix}@example.test`,displayName:"Phase 6 Reader"},pool);
    const workspace=await createWorkspace({name:"Phase 6 Workspace",slug:`phase6-${suffix}`},context(owner.principalId,suffix,"workspace"),pool);
    const project=await createProject({workspaceId:workspace.data.id,projectKey:"MAP",name:"Graph and Canvas"},context(owner.principalId,suffix,"project"),pool);
    const readerRoleId=newFolioId();
    await pool.query(`INSERT INTO role_templates(id,workspace_id,name,template_key,capabilities,is_system_template) VALUES($1,$2,'Graph Reader',$3,ARRAY['project.read','relationship.read','graph.read','canvas.read']::text[],false)`,[readerRoleId,workspace.data.id,`graph_reader_${suffix.slice(0,8)}`]);
    await pool.query(`INSERT INTO workspace_memberships(id,workspace_id,principal_id,role,status,invited_by_principal_id) VALUES($1,$2,$3,'member','active',$4)`,[newFolioId(),workspace.data.id,reader.principalId,owner.principalId]);
    await pool.query(`INSERT INTO project_memberships(id,workspace_id,project_id,principal_id,role_template_id,status,invited_by_principal_id) VALUES($1,$2,$3,$4,$5,'active',$6)`,[newFolioId(),workspace.data.id,project.data.id,reader.principalId,readerRoleId,owner.principalId]);

    const visible=await createNativePage({workspaceId:workspace.data.id,projectId:project.data.id,title:"Visible architecture",content:doc("Visible")},context(owner.principalId,suffix,"visible-page"),pool);
    const hidden=await createNativePage({workspaceId:workspace.data.id,projectId:project.data.id,title:"Hidden acquisition",content:doc("Highly confidential")},context(owner.principalId,suffix,"hidden-page"),pool);
    await pool.query(`INSERT INTO object_grants(id,workspace_id,project_id,principal_id,object_type,object_id,capabilities,granted_by_principal_id) VALUES($1,$2,$3,$4,'page',$5,ARRAY['page.read']::text[],$6)`,[newFolioId(),workspace.data.id,project.data.id,reader.principalId,visible.data.id,owner.principalId]);

    const relationType=await createRelationshipType({workspaceId:workspace.data.id,projectId:project.data.id,typeKey:"depends_on",displayName:"Depends on",sourceEntityTypes:["page"],targetEntityTypes:["page"]},context(owner.principalId,suffix,"relationship-type"),pool);
    await createTypedRelationship({workspaceId:workspace.data.id,projectId:project.data.id,relationshipTypeId:relationType.data.id,source:{type:"page",id:visible.data.id},target:{type:"page",id:hidden.data.id},provenance:"explicit"},context(owner.principalId,suffix,"relationship"),pool);
    expect(await listEntityRelationships({workspaceId:workspace.data.id,projectId:project.data.id,entityType:"page",entityId:visible.data.id},reader.principalId,pool)).toEqual([]);
    const graph=await executeGraphTraversal({workspaceId:workspace.data.id,projectId:project.data.id,rootEntities:[{type:"page",id:visible.data.id}],traversal:{depth:2,nodeLimit:100,edgeLimit:100}},reader.principalId,pool);
    expect(graph.nodes).toEqual([expect.objectContaining({id:visible.data.id,title:"Visible architecture"})]);
    expect(graph.edges).toEqual([]);
    expect(graph).not.toHaveProperty("omittedUnauthorized");
    expect(JSON.stringify(graph)).not.toContain(hidden.data.id);
    expect(JSON.stringify(graph)).not.toContain("Hidden acquisition");

    const canvasCreated=await createCanvas({workspaceId:workspace.data.id,projectId:project.data.id,title:"Private strategy map",visibility:"private"},context(owner.principalId,suffix,"canvas"),pool);
    await pool.query(`INSERT INTO object_grants(id,workspace_id,project_id,principal_id,object_type,object_id,capabilities,granted_by_principal_id) VALUES($1,$2,$3,$4,'canvas',$5,ARRAY['canvas.read']::text[],$6)`,[newFolioId(),workspace.data.id,project.data.id,reader.principalId,canvasCreated.data.id,owner.principalId]);
    const visibleCardId=newFolioId();const hiddenCardId=newFolioId();const connectorId=newFolioId();
    let scene=canvasCreated.data;
    scene=(await applyCanvasCommand({workspaceId:workspace.data.id,projectId:project.data.id,canvasId:scene.id,expectedRevision:scene.revision,clientId:"owner",clientSequence:1,command:{type:"element.create",element:{id:visibleCardId,kind:"entity_card",entityType:"page",entityId:visible.data.id,content:{title:"Visible architecture"},geometry:{x:10,y:10,width:200,height:100}}}},context(owner.principalId,suffix,"visible-card"),pool)).data;
    scene=(await applyCanvasCommand({workspaceId:workspace.data.id,projectId:project.data.id,canvasId:scene.id,expectedRevision:scene.revision,clientId:"owner",clientSequence:2,command:{type:"element.create",element:{id:hiddenCardId,kind:"entity_card",entityType:"page",entityId:hidden.data.id,content:{title:"Hidden acquisition"},geometry:{x:260,y:10,width:200,height:100}}}},context(owner.principalId,suffix,"hidden-card"),pool)).data;
    scene=(await applyCanvasCommand({workspaceId:workspace.data.id,projectId:project.data.id,canvasId:scene.id,expectedRevision:scene.revision,clientId:"owner",clientSequence:3,command:{type:"element.create",element:{id:connectorId,kind:"connector",content:{fromElementId:visibleCardId,toElementId:hiddenCardId},geometry:{}}}},context(owner.principalId,suffix,"connector"),pool)).data;
    const readerScene=await readCanvas({workspaceId:workspace.data.id,projectId:project.data.id,canvasId:scene.id},reader.principalId,pool);
    expect(readerScene.elements.map((element)=>element.id)).toEqual([visibleCardId]);
    expect(JSON.stringify(readerScene)).not.toContain(hidden.data.id);
    expect(JSON.stringify(readerScene)).not.toContain(connectorId);

    const exported=await previewMermaidExport({workspaceId:workspace.data.id,projectId:project.data.id,canvasId:scene.id},reader.principalId,pool);
    expect(exported.sourceText).toContain(visible.data.id);
    expect(exported.sourceText).not.toContain(hidden.data.id);
    expect(exported.sourceText).not.toContain("Hidden acquisition");

    const preview=await previewMermaidImport({workspaceId:workspace.data.id,projectId:project.data.id,canvasId:scene.id,sourceText:"flowchart LR\nA[Idea] -.-> B[Decision]\nclassDef ignored fill:#fff"},owner.principalId,pool);
    expect(preview.losses).toEqual(expect.arrayContaining([expect.stringContaining("standard connector")]));
    expect(preview.warnings).toEqual(expect.arrayContaining([expect.stringContaining("unsupported directive")]));
    const imported=await executeMermaidImport({workspaceId:workspace.data.id,projectId:project.data.id,previewId:preview.id,clientId:"mermaid-import"},context(owner.principalId,suffix,"mermaid"),pool);
    expect(imported.createdElementIds).toHaveLength(3);
    expect(imported.revision).toBeGreaterThan(scene.revision);
  });
});

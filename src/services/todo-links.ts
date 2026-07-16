import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { authorizeIssueCapability } from "@/services/issue-access";
import { authorizePageCapability } from "@/services/page-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import {
  findIdempotentResult,
  inTransaction,
  lockIdempotencyKey,
  recordMutation,
  requestDigest,
} from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";
import { authorizeScheduleObject, readTodoListPolicy } from "@/services/schedule-access";

export type TodoLink = {
  id: string;
  todoId: string;
  linkKind: "issue" | "page";
  targetIssueId: string | null;
  targetPageId: string | null;
  label: string | null;
  revision: number;
  createdAt: string;
};

type LinkRow = {
  id: string;
  todo_id: string;
  link_kind: TodoLink["linkKind"];
  target_issue_id: string | null;
  target_page_id: string | null;
  label: string | null;
  revision: string;
  created_at: Date;
};

type TodoScopeRow = { list_id: string; revision: string; archived_at: Date | null };

function mapLink(row: LinkRow): TodoLink {
  return {
    id: row.id,
    todoId: row.todo_id,
    linkKind: row.link_kind,
    targetIssueId: row.target_issue_id,
    targetPageId: row.target_page_id,
    label: row.label,
    revision: Number(row.revision),
    createdAt: row.created_at.toISOString(),
  };
}

async function todoScope(
  client: Parameters<typeof readTodoListPolicy>[0],
  input: { workspaceId: string; projectId: string; todoId: string },
): Promise<TodoScopeRow> {
  const result = await client.query<TodoScopeRow>(`
    SELECT list_id,revision,archived_at FROM todos
    WHERE workspace_id=$1 AND project_id=$2 AND id=$3
  `, [input.workspaceId,input.projectId,input.todoId]);
  const row=result.rows[0];
  if(!row)throw new FoundationServiceError("NOT_FOUND","To-do was not found.");
  return row;
}

async function authorizeTodoLinkAccess(
  client: Parameters<typeof readTodoListPolicy>[0],
  input:{workspaceId:string;projectId:string;todoId:string;principalId:string;capability:"todo.read"|"todo.edit"},
){
  const todo=await todoScope(client,input);
  const policy=await readTodoListPolicy(client,{workspaceId:input.workspaceId,projectId:input.projectId,listId:todo.list_id});
  await authorizeScheduleObject(client,{workspaceId:input.workspaceId,projectId:input.projectId,
    principalId:input.principalId,capability:input.capability,objectType:"todo_list",objectId:todo.list_id,
    ownerPrincipalId:policy.ownerPrincipalId,visibility:policy.visibility});
  return todo;
}

async function authorizeTarget(
  client: Parameters<typeof readTodoListPolicy>[0],
  input:{workspaceId:string;projectId:string;principalId:string;linkKind:"issue"|"page";targetId:string},
){
  if(input.linkKind==="issue"){
    await authorizeIssueCapability(client,{workspaceId:input.workspaceId,projectId:input.projectId,
      principalId:input.principalId,capability:"issue.read",issueId:input.targetId});
  }else{
    await authorizePageCapability(client,{workspaceId:input.workspaceId,projectId:input.projectId,
      principalId:input.principalId,capability:"page.read",pageId:input.targetId});
  }
}

export async function listTodoLinks(
  input:{workspaceId:string;projectId:string;todoId:string},
  principalId:string,
  pool:Pool=postgresPool(),
):Promise<TodoLink[]>{
  return inTransaction(pool,async(client)=>{
    await establishTenantContext(client,input.workspaceId,principalId);
    await authorizeTodoLinkAccess(client,{...input,principalId,capability:"todo.read"});
    const result=await client.query<LinkRow>(`SELECT id,todo_id,link_kind,target_issue_id,target_page_id,label,revision,created_at
      FROM todo_links WHERE workspace_id=$1 AND project_id=$2 AND todo_id=$3 AND archived_at IS NULL
      ORDER BY created_at,id`,[input.workspaceId,input.projectId,input.todoId]);
    const visible:TodoLink[]=[];
    for(const row of result.rows){
      try{
        await authorizeTarget(client,{workspaceId:input.workspaceId,projectId:input.projectId,principalId,
          linkKind:row.link_kind,targetId:(row.target_issue_id??row.target_page_id)!});
        visible.push(mapLink(row));
      }catch(error){
        if(error instanceof FoundationServiceError&&["NOT_FOUND","CAPABILITY_DENIED"].includes(error.code))continue;
        throw error;
      }
    }
    return visible;
  });
}

export async function addTodoLink(
  raw:{workspaceId:string;projectId:string;todoId:string;expectedTodoRevision:number;linkKind:"issue"|"page";targetId:string;label?:string|null},
  context:MutationContext,
  pool:Pool=postgresPool(),
):Promise<MutationResult<TodoLink>>{
  if(!Number.isSafeInteger(raw.expectedTodoRevision)||raw.expectedTodoRevision<1)throw new FoundationServiceError("VALIDATION_FAILED","Expected revision must be positive.");
  const label=raw.label?.trim()||null;
  if(label&&label.length>240)throw new FoundationServiceError("VALIDATION_FAILED","Link label is too long.");
  const input={...raw,label};
  const operation="todo.link.add";
  const digest=requestDigest(input);
  return inTransaction(pool,async(client)=>{
    await establishTenantContext(client,input.workspaceId,context.actorPrincipalId);
    await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay=await findIdempotentResult<TodoLink>(client,{workspaceId:input.workspaceId,projectId:input.projectId,
      principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest});
    if(replay)return replay;
    const todo=await authorizeTodoLinkAccess(client,{...input,principalId:context.actorPrincipalId,capability:"todo.edit"});
    if(todo.archived_at)throw new FoundationServiceError("CONFLICT","Archived to-dos cannot receive links.");
    if(Number(todo.revision)!==input.expectedTodoRevision)throw new FoundationServiceError("REVISION_CONFLICT","To-do changed after it was read.",{
      expectedRevision:input.expectedTodoRevision,currentRevision:Number(todo.revision)});
    await authorizeTarget(client,{workspaceId:input.workspaceId,projectId:input.projectId,principalId:context.actorPrincipalId,
      linkKind:input.linkKind,targetId:input.targetId});
    const id=newFolioId();
    const inserted=await client.query<LinkRow>(`
      INSERT INTO todo_links(id,workspace_id,project_id,todo_id,link_kind,target_issue_id,target_page_id,label,created_by_principal_id)
      VALUES($1,$2,$3,$4,$5,CASE WHEN $5='issue' THEN $6::uuid END,CASE WHEN $5='page' THEN $6::uuid END,$7,$8)
      RETURNING id,todo_id,link_kind,target_issue_id,target_page_id,label,revision,created_at
    `,[id,input.workspaceId,input.projectId,input.todoId,input.linkKind,input.targetId,input.label,context.actorPrincipalId]);
    await client.query(`UPDATE todos SET revision=revision+1,updated_by_principal_id=$5,updated_at=now()
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND revision=$4`,[
      input.workspaceId,input.projectId,input.todoId,input.expectedTodoRevision,context.actorPrincipalId]);
    const data=mapLink(inserted.rows[0]!);
    return recordMutation(client,{workspaceId:input.workspaceId,projectId:input.projectId,context,operation,digest,
      action:operation,targetType:"todo_link",targetId:id,aggregateType:"todo",aggregateRevision:input.expectedTodoRevision+1,
      eventType:"todo.link_added.v1",inputSummary:{todoId:input.todoId,linkKind:input.linkKind},
      resultSummary:{linkId:id,todoId:input.todoId,linkKind:input.linkKind},data});
  });
}

export async function removeTodoLink(
  raw:{workspaceId:string;projectId:string;todoId:string;linkId:string;expectedTodoRevision:number},
  context:MutationContext,
  pool:Pool=postgresPool(),
):Promise<MutationResult<{id:string;todoId:string;archived:true}>>{
  const operation="todo.link.remove";
  const digest=requestDigest(raw);
  return inTransaction(pool,async(client)=>{
    await establishTenantContext(client,raw.workspaceId,context.actorPrincipalId);
    await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay=await findIdempotentResult<{id:string;todoId:string;archived:true}>(client,{workspaceId:raw.workspaceId,projectId:raw.projectId,
      principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest});
    if(replay)return replay;
    const todo=await authorizeTodoLinkAccess(client,{...raw,principalId:context.actorPrincipalId,capability:"todo.edit"});
    if(Number(todo.revision)!==raw.expectedTodoRevision)throw new FoundationServiceError("REVISION_CONFLICT","To-do changed after it was read.",{
      expectedRevision:raw.expectedTodoRevision,currentRevision:Number(todo.revision)});
    const removed=await client.query<{id:string}>(`UPDATE todo_links SET archived_at=now(),revision=revision+1
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND todo_id=$4 AND archived_at IS NULL RETURNING id`,[
      raw.workspaceId,raw.projectId,raw.linkId,raw.todoId]);
    if(!removed.rows[0])throw new FoundationServiceError("NOT_FOUND","To-do link was not found.");
    await client.query(`UPDATE todos SET revision=revision+1,updated_by_principal_id=$5,updated_at=now()
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND revision=$4`,[
      raw.workspaceId,raw.projectId,raw.todoId,raw.expectedTodoRevision,context.actorPrincipalId]);
    const data={id:raw.linkId,todoId:raw.todoId,archived:true as const};
    return recordMutation(client,{workspaceId:raw.workspaceId,projectId:raw.projectId,context,operation,digest,
      action:operation,targetType:"todo_link",targetId:raw.linkId,aggregateType:"todo",aggregateRevision:raw.expectedTodoRevision+1,
      eventType:"todo.link_removed.v1",inputSummary:{todoId:raw.todoId},resultSummary:data,data});
  });
}

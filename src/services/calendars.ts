import type { Pool, PoolClient } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { listIssues } from "@/services/issues";
import { FoundationServiceError } from "@/services/foundation/errors";
import {
  findIdempotentResult,
  inTransaction,
  lockIdempotencyKey,
  recordMutation,
  requestDigest,
} from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";
import {
  authorizeScheduleObject,
  authorizeScheduleProjectCapability,
  readCalendarPolicy,
  scheduleObjectReadScope,
} from "@/services/schedule-access";
import { emptyScheduleDocument, structuredScheduleDocument } from "@/services/schedule-document";

export type Calendar = {
  id: string;
  workspaceId: string;
  projectId: string;
  ownerPrincipalId: string;
  name: string;
  visibility: "private" | "project";
  timeZone: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type CalendarEntry = {
  id: string;
  calendarId: string;
  sourceKind: "manual" | "todo" | "issue" | "external";
  todoId: string | null;
  issueId: string | null;
  title: string;
  body: Record<string, unknown>;
  plainText: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  timeZone: string;
  revision: number;
  createdByPrincipalId: string;
  updatedByPrincipalId: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type CalendarViewItem = {
  id: string;
  source: "calendar_entry" | "todo_start" | "todo_due" | "issue_start" | "issue_due";
  sourceId: string;
  calendarId: string | null;
  title: string;
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  timeZone: string;
};

type CalendarRow = {
  id: string; workspace_id: string; project_id: string; owner_principal_id: string;
  name: string; visibility: Calendar["visibility"]; time_zone: string; revision: string;
  created_at: Date; updated_at: Date; archived_at: Date | null;
};

type EntryRow = {
  id: string; calendar_id: string; source_kind: CalendarEntry["sourceKind"];
  todo_id: string | null; issue_id: string | null; title: string;
  body: Record<string, unknown>; plain_text: string; starts_at: Date; ends_at: Date;
  all_day: boolean; time_zone: string; revision: string;
  created_by_principal_id: string; updated_by_principal_id: string;
  created_at: Date; updated_at: Date; archived_at: Date | null;
};

const calendarColumns = `id,workspace_id,project_id,owner_principal_id,name,visibility,time_zone,revision,created_at,updated_at,archived_at`;
const entryColumns = `id,calendar_id,source_kind,todo_id,issue_id,title,body,plain_text,starts_at,ends_at,all_day,time_zone,revision,created_by_principal_id,updated_by_principal_id,created_at,updated_at,archived_at`;

function mapCalendar(row: CalendarRow): Calendar {
  return { id:row.id,workspaceId:row.workspace_id,projectId:row.project_id,
    ownerPrincipalId:row.owner_principal_id,name:row.name,visibility:row.visibility,
    timeZone:row.time_zone,revision:Number(row.revision),createdAt:row.created_at.toISOString(),
    updatedAt:row.updated_at.toISOString(),archivedAt:row.archived_at?.toISOString()??null };
}
function mapEntry(row:EntryRow):CalendarEntry{
  return {id:row.id,calendarId:row.calendar_id,sourceKind:row.source_kind,todoId:row.todo_id,
    issueId:row.issue_id,title:row.title,body:row.body,plainText:row.plain_text,
    startsAt:row.starts_at.toISOString(),endsAt:row.ends_at.toISOString(),allDay:row.all_day,
    timeZone:row.time_zone,revision:Number(row.revision),createdByPrincipalId:row.created_by_principal_id,
    updatedByPrincipalId:row.updated_by_principal_id,createdAt:row.created_at.toISOString(),
    updatedAt:row.updated_at.toISOString(),archivedAt:row.archived_at?.toISOString()??null};
}
function name(value:string){const result=value.trim();if(!result||result.length>120)throw new FoundationServiceError("VALIDATION_FAILED","Calendar name must contain 1 to 120 characters.");return result;}
function title(value:string){const result=value.trim();if(!result||result.length>240)throw new FoundationServiceError("VALIDATION_FAILED","Calendar entry title must contain 1 to 240 characters.");return result;}
function revision(value:number){if(!Number.isSafeInteger(value)||value<1)throw new FoundationServiceError("VALIDATION_FAILED","Expected revision must be positive.");}
function zone(value:string|undefined){const result=value?.trim()||"UTC";try{new Intl.DateTimeFormat("en",{timeZone:result}).format(new Date());}catch{throw new FoundationServiceError("VALIDATION_FAILED","Time zone is not supported.",{timeZone:result});}return result;}
function instant(value:string,label:string){const result=new Date(value);if(Number.isNaN(result.getTime()))throw new FoundationServiceError("VALIDATION_FAILED",`${label} must be an ISO date-time.`);return result.toISOString();}
function window(start:string,end:string){const startsAt=instant(start,"Start time");const endsAt=instant(end,"End time");if(new Date(endsAt)<=new Date(startsAt))throw new FoundationServiceError("VALIDATION_FAILED","Calendar entry end must follow its start.");return{startsAt,endsAt};}

async function authorizeCalendar(client:PoolClient,input:{workspaceId:string;projectId:string;calendarId:string;principalId:string;capability:"calendar.read"|"calendar.edit"|"calendar.archive"}){
  const policy=await readCalendarPolicy(client,input);
  await authorizeScheduleObject(client,{workspaceId:input.workspaceId,projectId:input.projectId,
    principalId:input.principalId,capability:input.capability,objectType:"calendar",objectId:input.calendarId,
    ownerPrincipalId:policy.ownerPrincipalId,visibility:policy.visibility});
  return policy;
}

export async function listCalendars(input:{workspaceId:string;projectId:string;includeArchived?:boolean},principalId:string,pool:Pool=postgresPool()):Promise<Calendar[]>{
  return inTransaction(pool,async(client)=>{
    await establishTenantContext(client,input.workspaceId,principalId);
    const scope=await scheduleObjectReadScope(client,{workspaceId:input.workspaceId,projectId:input.projectId,
      principalId,objectType:"calendar",capability:"calendar.read"});
    const result=await client.query<CalendarRow>(`SELECT ${calendarColumns} FROM calendars
      WHERE workspace_id=$1 AND project_id=$2 AND ($3::boolean OR archived_at IS NULL)
        AND (owner_principal_id=$4 OR ($5::boolean AND visibility='project') OR id=ANY($6::uuid[]))
      ORDER BY archived_at NULLS FIRST,updated_at DESC,id`,[
      input.workspaceId,input.projectId,input.includeArchived??false,principalId,scope.projectWide,scope.objectIds]);
    return result.rows.map(mapCalendar);
  });
}

export async function createCalendar(raw:{workspaceId:string;projectId:string;name:string;visibility?:Calendar["visibility"];timeZone?:string},context:MutationContext,pool:Pool=postgresPool()):Promise<MutationResult<Calendar>>{
  const input={...raw,name:name(raw.name),visibility:raw.visibility??"private",timeZone:zone(raw.timeZone)};
  const operation="calendar.create";const digest=requestDigest(input);
  return inTransaction(pool,async(client)=>{
    await establishTenantContext(client,input.workspaceId,context.actorPrincipalId);
    await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay=await findIdempotentResult<Calendar>(client,{workspaceId:input.workspaceId,projectId:input.projectId,principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest});if(replay)return replay;
    await authorizeScheduleProjectCapability(client,{workspaceId:input.workspaceId,projectId:input.projectId,principalId:context.actorPrincipalId,capability:"calendar.create"});
    if(input.visibility==="project")await authorizeScheduleProjectCapability(client,{workspaceId:input.workspaceId,projectId:input.projectId,principalId:context.actorPrincipalId,capability:"project.update"});
    const id=newFolioId();const inserted=await client.query<CalendarRow>(`INSERT INTO calendars(id,workspace_id,project_id,owner_principal_id,name,visibility,time_zone)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${calendarColumns}`,[id,input.workspaceId,input.projectId,context.actorPrincipalId,input.name,input.visibility,input.timeZone]);
    const data=mapCalendar(inserted.rows[0]!);return recordMutation(client,{workspaceId:input.workspaceId,projectId:input.projectId,context,operation,digest,action:operation,targetType:"calendar",targetId:id,aggregateType:"calendar",aggregateRevision:1,eventType:"calendar.created.v1",inputSummary:{visibility:input.visibility,nameLength:input.name.length,timeZone:input.timeZone},resultSummary:{calendarId:id,visibility:input.visibility},data});
  });
}

export async function updateCalendar(raw:{workspaceId:string;projectId:string;calendarId:string;expectedRevision:number;name?:string;visibility?:Calendar["visibility"];timeZone?:string},context:MutationContext,pool:Pool=postgresPool()):Promise<MutationResult<Calendar>>{
  revision(raw.expectedRevision);if(raw.name===undefined&&raw.visibility===undefined&&raw.timeZone===undefined)throw new FoundationServiceError("VALIDATION_FAILED","At least one calendar field must change.");
  const input={...raw,name:raw.name===undefined?undefined:name(raw.name),timeZone:raw.timeZone===undefined?undefined:zone(raw.timeZone)};const operation="calendar.update";const digest=requestDigest(input);
  return inTransaction(pool,async(client)=>{
    await establishTenantContext(client,input.workspaceId,context.actorPrincipalId);await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay=await findIdempotentResult<Calendar>(client,{workspaceId:input.workspaceId,projectId:input.projectId,principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest});if(replay)return replay;
    const policy=await authorizeCalendar(client,{...input,principalId:context.actorPrincipalId,capability:"calendar.edit"});if(policy.archived)throw new FoundationServiceError("CONFLICT","Archived calendars cannot be edited.");
    if(input.visibility==="project"||(policy.visibility==="project"&&input.visibility==="private"))await authorizeScheduleProjectCapability(client,{workspaceId:input.workspaceId,projectId:input.projectId,principalId:context.actorPrincipalId,capability:"project.update"});
    const result=await client.query<CalendarRow>(`UPDATE calendars SET name=coalesce($5,name),visibility=coalesce($6,visibility),time_zone=coalesce($7,time_zone),revision=revision+1,updated_at=now()
      WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND revision=$4 AND archived_at IS NULL RETURNING ${calendarColumns}`,[input.workspaceId,input.projectId,input.calendarId,input.expectedRevision,input.name??null,input.visibility??null,input.timeZone??null]);
    if(!result.rows[0]){const current=await readCalendarPolicy(client,input);throw new FoundationServiceError("REVISION_CONFLICT","Calendar changed after it was read.",{expectedRevision:input.expectedRevision,currentRevision:current.revision});}
    const data=mapCalendar(result.rows[0]);return recordMutation(client,{workspaceId:input.workspaceId,projectId:input.projectId,context,operation,digest,action:operation,targetType:"calendar",targetId:input.calendarId,aggregateType:"calendar",aggregateRevision:data.revision,eventType:"calendar.updated.v1",inputSummary:{changedFields:[input.name!==undefined?"name":null,input.visibility!==undefined?"visibility":null,input.timeZone!==undefined?"timeZone":null].filter(Boolean)},resultSummary:{calendarId:data.id,revision:data.revision,visibility:data.visibility},data});
  });
}

export async function listCalendarEntries(input:{workspaceId:string;projectId:string;calendarId:string;from:string;to:string;includeArchived?:boolean},principalId:string,pool:Pool=postgresPool()):Promise<CalendarEntry[]>{
  const range=window(input.from,input.to);
  return inTransaction(pool,async(client)=>{await establishTenantContext(client,input.workspaceId,principalId);await authorizeCalendar(client,{...input,principalId,capability:"calendar.read"});
    const result=await client.query<EntryRow>(`SELECT ${entryColumns} FROM calendar_entries WHERE workspace_id=$1 AND project_id=$2 AND calendar_id=$3 AND starts_at<$5 AND ends_at>$4 AND ($6::boolean OR archived_at IS NULL) ORDER BY starts_at,ends_at,id`,[input.workspaceId,input.projectId,input.calendarId,range.startsAt,range.endsAt,input.includeArchived??false]);return result.rows.map(mapEntry);});
}

export async function createCalendarEntry(raw:{workspaceId:string;projectId:string;calendarId:string;sourceKind?:CalendarEntry["sourceKind"];todoId?:string|null;issueId?:string|null;title:string;body?:Record<string,unknown>;startsAt:string;endsAt:string;allDay?:boolean;timeZone?:string},context:MutationContext,pool:Pool=postgresPool()):Promise<MutationResult<CalendarEntry>>{
  const content=raw.body===undefined?emptyScheduleDocument():structuredScheduleDocument(raw.body,"Calendar entry body");const times=window(raw.startsAt,raw.endsAt);
  const input={...raw,sourceKind:raw.sourceKind??"manual",todoId:raw.todoId??null,issueId:raw.issueId??null,title:title(raw.title),body:content.document,plainText:content.plainText,...times,allDay:raw.allDay??false,timeZone:zone(raw.timeZone)};
  const operation="calendar_entry.create";const digest=requestDigest(input);
  return inTransaction(pool,async(client)=>{await establishTenantContext(client,input.workspaceId,context.actorPrincipalId);await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay=await findIdempotentResult<CalendarEntry>(client,{workspaceId:input.workspaceId,projectId:input.projectId,principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest});if(replay)return replay;
    const policy=await authorizeCalendar(client,{...input,principalId:context.actorPrincipalId,capability:"calendar.edit"});if(policy.archived)throw new FoundationServiceError("CONFLICT","Archived calendars cannot receive entries.");
    const id=newFolioId();const result=await client.query<EntryRow>(`INSERT INTO calendar_entries(id,workspace_id,project_id,calendar_id,source_kind,todo_id,issue_id,title,body,plain_text,starts_at,ends_at,all_day,time_zone,created_by_principal_id,updated_by_principal_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15) RETURNING ${entryColumns}`,[id,input.workspaceId,input.projectId,input.calendarId,input.sourceKind,input.todoId,input.issueId,input.title,input.body,input.plainText,input.startsAt,input.endsAt,input.allDay,input.timeZone,context.actorPrincipalId]);
    const data=mapEntry(result.rows[0]!);return recordMutation(client,{workspaceId:input.workspaceId,projectId:input.projectId,context,operation,digest,action:operation,targetType:"calendar_entry",targetId:id,aggregateType:"calendar_entry",aggregateRevision:1,eventType:"calendar_entry.created.v1",inputSummary:{calendarId:input.calendarId,sourceKind:input.sourceKind,titleLength:input.title.length,bodyLength:input.plainText.length,allDay:input.allDay},resultSummary:{entryId:id,calendarId:input.calendarId},data});
  });
}

export async function updateCalendarEntry(raw:{workspaceId:string;projectId:string;entryId:string;expectedRevision:number;title?:string;body?:Record<string,unknown>;startsAt?:string;endsAt?:string;allDay?:boolean;timeZone?:string},context:MutationContext,pool:Pool=postgresPool()):Promise<MutationResult<CalendarEntry>>{
  revision(raw.expectedRevision);const fields=["title","body","startsAt","endsAt","allDay","timeZone"].filter((field)=>Object.prototype.hasOwnProperty.call(raw,field));if(!fields.length)throw new FoundationServiceError("VALIDATION_FAILED","At least one entry field must change.");
  const content=raw.body===undefined?undefined:structuredScheduleDocument(raw.body,"Calendar entry body");const input={...raw,title:raw.title===undefined?undefined:title(raw.title),body:content?.document,plainText:content?.plainText,startsAt:raw.startsAt===undefined?undefined:instant(raw.startsAt,"Start time"),endsAt:raw.endsAt===undefined?undefined:instant(raw.endsAt,"End time"),timeZone:raw.timeZone===undefined?undefined:zone(raw.timeZone)};const operation="calendar_entry.update";const digest=requestDigest(input);
  return inTransaction(pool,async(client)=>{await establishTenantContext(client,input.workspaceId,context.actorPrincipalId);await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);
    const replay=await findIdempotentResult<CalendarEntry>(client,{workspaceId:input.workspaceId,projectId:input.projectId,principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest});if(replay)return replay;
    const current=await client.query<EntryRow>(`SELECT ${entryColumns} FROM calendar_entries WHERE workspace_id=$1 AND project_id=$2 AND id=$3`,[input.workspaceId,input.projectId,input.entryId]);const row=current.rows[0];if(!row)throw new FoundationServiceError("NOT_FOUND","Calendar entry was not found.");
    await authorizeCalendar(client,{workspaceId:input.workspaceId,projectId:input.projectId,calendarId:row.calendar_id,principalId:context.actorPrincipalId,capability:"calendar.edit"});if(row.archived_at)throw new FoundationServiceError("CONFLICT","Archived entries cannot be edited.");
    const startsAt=input.startsAt??row.starts_at.toISOString();const endsAt=input.endsAt??row.ends_at.toISOString();window(startsAt,endsAt);
    const result=await client.query<EntryRow>(`UPDATE calendar_entries SET title=coalesce($5,title),body=coalesce($6,body),plain_text=coalesce($7,plain_text),starts_at=coalesce($8,starts_at),ends_at=coalesce($9,ends_at),all_day=coalesce($10,all_day),time_zone=coalesce($11,time_zone),revision=revision+1,updated_by_principal_id=$12,updated_at=now() WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND revision=$4 AND archived_at IS NULL RETURNING ${entryColumns}`,[input.workspaceId,input.projectId,input.entryId,input.expectedRevision,input.title??null,input.body??null,input.plainText??null,input.startsAt??null,input.endsAt??null,input.allDay??null,input.timeZone??null,context.actorPrincipalId]);
    if(!result.rows[0])throw new FoundationServiceError("REVISION_CONFLICT","Calendar entry changed after it was read.",{expectedRevision:input.expectedRevision,currentRevision:Number(row.revision)});const data=mapEntry(result.rows[0]);return recordMutation(client,{workspaceId:input.workspaceId,projectId:input.projectId,context,operation,digest,action:operation,targetType:"calendar_entry",targetId:input.entryId,aggregateType:"calendar_entry",aggregateRevision:data.revision,eventType:"calendar_entry.updated.v1",inputSummary:{changedFields:fields,bodyLength:input.plainText?.length},resultSummary:{entryId:data.id,calendarId:data.calendarId,revision:data.revision},data});
  });
}

async function setCalendarArchived(raw:{workspaceId:string;projectId:string;calendarId:string;expectedRevision:number},context:MutationContext,archived:boolean,pool:Pool):Promise<MutationResult<Calendar>>{
  revision(raw.expectedRevision);const operation=archived?"calendar.archive":"calendar.restore";const digest=requestDigest(raw);return inTransaction(pool,async(client)=>{await establishTenantContext(client,raw.workspaceId,context.actorPrincipalId);await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);const replay=await findIdempotentResult<Calendar>(client,{workspaceId:raw.workspaceId,projectId:raw.projectId,principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest});if(replay)return replay;await authorizeCalendar(client,{...raw,principalId:context.actorPrincipalId,capability:"calendar.archive"});if(archived){const active=await client.query(`SELECT 1 FROM calendar_entries WHERE workspace_id=$1 AND project_id=$2 AND calendar_id=$3 AND archived_at IS NULL LIMIT 1`,[raw.workspaceId,raw.projectId,raw.calendarId]);if(active.rows[0])throw new FoundationServiceError("CONFLICT","Archive calendar entries before archiving the calendar.");}
    const result=await client.query<CalendarRow>(`UPDATE calendars SET archived_at=CASE WHEN $5::boolean THEN now() ELSE NULL END,revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND project_id=$2 AND id=$3 AND revision=$4 AND (($5::boolean AND archived_at IS NULL) OR (NOT $5::boolean AND archived_at IS NOT NULL)) RETURNING ${calendarColumns}`,[raw.workspaceId,raw.projectId,raw.calendarId,raw.expectedRevision,archived]);if(!result.rows[0]){const current=await readCalendarPolicy(client,raw);throw new FoundationServiceError("REVISION_CONFLICT","Calendar lifecycle changed after it was read.",{expectedRevision:raw.expectedRevision,currentRevision:current.revision});}const data=mapCalendar(result.rows[0]);return recordMutation(client,{workspaceId:raw.workspaceId,projectId:raw.projectId,context,operation,digest,action:operation,targetType:"calendar",targetId:raw.calendarId,aggregateType:"calendar",aggregateRevision:data.revision,eventType:archived?"calendar.archived.v1":"calendar.restored.v1",inputSummary:{},resultSummary:{calendarId:data.id,revision:data.revision},data});});
}
export function archiveCalendar(input:{workspaceId:string;projectId:string;calendarId:string;expectedRevision:number},context:MutationContext,pool:Pool=postgresPool()){return setCalendarArchived(input,context,true,pool);}
export function restoreCalendar(input:{workspaceId:string;projectId:string;calendarId:string;expectedRevision:number},context:MutationContext,pool:Pool=postgresPool()){return setCalendarArchived(input,context,false,pool);}

export async function calendarView(input:{workspaceId:string;projectId:string;from:string;to:string;includeTodos?:boolean;includeIssues?:boolean},principalId:string,pool:Pool=postgresPool()):Promise<CalendarViewItem[]>{
  const range=window(input.from,input.to);const calendars=await listCalendars({workspaceId:input.workspaceId,projectId:input.projectId},principalId,pool);
  const calendarIds=calendars.map((item)=>item.id);const items=await inTransaction(pool,async(client)=>{await establishTenantContext(client,input.workspaceId,principalId);const result:CalendarViewItem[]=[];
    if(calendarIds.length){const entries=await client.query<EntryRow>(`SELECT ${entryColumns} FROM calendar_entries WHERE workspace_id=$1 AND project_id=$2 AND calendar_id=ANY($3::uuid[]) AND starts_at<$5 AND ends_at>$4 AND archived_at IS NULL`,[input.workspaceId,input.projectId,calendarIds,range.startsAt,range.endsAt]);for(const row of entries.rows){const entry=mapEntry(row);result.push({id:`entry:${entry.id}`,source:"calendar_entry",sourceId:entry.id,calendarId:entry.calendarId,title:entry.title,startsAt:entry.startsAt,endsAt:entry.endsAt,allDay:entry.allDay,timeZone:entry.timeZone});}}
    if(input.includeTodos!==false){const scope=await scheduleObjectReadScope(client,{workspaceId:input.workspaceId,projectId:input.projectId,principalId,objectType:"todo_list",capability:"todo.read"});const todos=await client.query<{id:string;list_id:string;title:string;starts_at:Date|null;due_at:Date|null;time_zone:string}>(`SELECT t.id,t.list_id,t.title,t.starts_at,t.due_at,t.time_zone FROM todos t JOIN todo_lists l ON l.workspace_id=t.workspace_id AND l.project_id=t.project_id AND l.id=t.list_id WHERE t.workspace_id=$1 AND t.project_id=$2 AND t.archived_at IS NULL AND t.status='open' AND (l.owner_principal_id=$3 OR ($4::boolean AND l.visibility='project') OR l.id=ANY($5::uuid[])) AND ((t.starts_at >= $6 AND t.starts_at < $7) OR (t.due_at >= $6 AND t.due_at < $7))`,[input.workspaceId,input.projectId,principalId,scope.projectWide,scope.objectIds,range.startsAt,range.endsAt]);for(const todo of todos.rows){if(todo.starts_at)result.push({id:`todo-start:${todo.id}`,source:"todo_start",sourceId:todo.id,calendarId:null,title:todo.title,startsAt:todo.starts_at.toISOString(),endsAt:new Date(todo.starts_at.getTime()+30*60_000).toISOString(),allDay:false,timeZone:todo.time_zone});if(todo.due_at)result.push({id:`todo-due:${todo.id}`,source:"todo_due",sourceId:todo.id,calendarId:null,title:todo.title,startsAt:todo.due_at.toISOString(),endsAt:new Date(todo.due_at.getTime()+30*60_000).toISOString(),allDay:false,timeZone:todo.time_zone});}}
    return result;});
  if(input.includeIssues!==false){try{const issues=await listIssues({workspaceId:input.workspaceId,projectId:input.projectId,includeArchived:false,limit:5000},principalId,pool);for(const issue of issues){if(issue.startOn){const start=new Date(`${issue.startOn}T00:00:00.000Z`);if(start>=new Date(range.startsAt)&&start<new Date(range.endsAt))items.push({id:`issue-start:${issue.id}`,source:"issue_start",sourceId:issue.id,calendarId:null,title:issue.title,startsAt:start.toISOString(),endsAt:new Date(start.getTime()+86_400_000).toISOString(),allDay:true,timeZone:"UTC"});}if(issue.dueOn){const due=new Date(`${issue.dueOn}T00:00:00.000Z`);if(due>=new Date(range.startsAt)&&due<new Date(range.endsAt))items.push({id:`issue-due:${issue.id}`,source:"issue_due",sourceId:issue.id,calendarId:null,title:issue.title,startsAt:due.toISOString(),endsAt:new Date(due.getTime()+86_400_000).toISOString(),allDay:true,timeZone:"UTC"});}}}catch(error){if(!(error instanceof FoundationServiceError)||error.code!=="CAPABILITY_DENIED")throw error;}}
  return items.sort((left,right)=>left.startsAt.localeCompare(right.startsAt)||left.id.localeCompare(right.id));
}

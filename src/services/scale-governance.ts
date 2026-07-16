import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { newFolioId } from "@/lib/folio-ids";
import { authorizeEcosystemProjectCapability } from "@/services/ecosystem-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import { findIdempotentResult, inTransaction, lockIdempotencyKey, recordMutation, requestDigest } from "@/services/foundation/internal";
import type { MutationContext, MutationResult } from "@/services/foundation/types";

export type ScaleComponent = "search" | "queue" | "realtime" | "database" | "object_storage";
export type ScaleMeasurement = {
  id: string; component: ScaleComponent; metricName: string; windowStart: string; windowEnd: string;
  sampleCount: number; p50: number | null; p95: number | null; p99: number | null;
  maximum: number | null; dimensions: Record<string,unknown>; createdAt: string;
};
export type ScaleDecision = {
  id: string; component: ScaleComponent;
  decision: "keep_postgres" | "evaluate_extraction" | "approve_extraction" | "reject_extraction";
  rationale: string; thresholds: Record<string,unknown>; evidence: Record<string,unknown>;
  revision: number; effectiveAt: string; supersededAt: string | null; createdAt: string;
};

type MeasurementRow = {
  id:string;component:ScaleComponent;metric_name:string;window_start:Date;window_end:Date;
  sample_count:string;p50:number|null;p95:number|null;p99:number|null;maximum:number|null;
  dimensions:Record<string,unknown>;created_at:Date;
};
type DecisionRow = {
  id:string;component:ScaleComponent;decision:ScaleDecision["decision"];rationale:string;
  thresholds:Record<string,unknown>;evidence:Record<string,unknown>;revision:string;
  effective_at:Date;superseded_at:Date|null;created_at:Date;
};

const mapMeasurement = (row:MeasurementRow):ScaleMeasurement => ({
  id:row.id,component:row.component,metricName:row.metric_name,windowStart:row.window_start.toISOString(),
  windowEnd:row.window_end.toISOString(),sampleCount:Number(row.sample_count),p50:row.p50,p95:row.p95,
  p99:row.p99,maximum:row.maximum,dimensions:row.dimensions,createdAt:row.created_at.toISOString(),
});
const mapDecision = (row:DecisionRow):ScaleDecision => ({
  id:row.id,component:row.component,decision:row.decision,rationale:row.rationale,
  thresholds:row.thresholds,evidence:row.evidence,revision:Number(row.revision),
  effectiveAt:row.effective_at.toISOString(),supersededAt:row.superseded_at?.toISOString()??null,
  createdAt:row.created_at.toISOString(),
});
function instant(value:string,label:string){const date=new Date(value);if(Number.isNaN(date.getTime()))throw new FoundationServiceError("VALIDATION_FAILED",`${label} must be an ISO date-time.`);return date;}
function metric(value:number|null|undefined,label:string){if(value===undefined||value===null)return null;if(!Number.isFinite(value)||value<0)throw new FoundationServiceError("VALIDATION_FAILED",`${label} must be a non-negative number.`);return value;}

export async function recordScaleMeasurement(raw:{workspaceId:string;projectId:string;component:ScaleComponent;metricName:string;windowStart:string;windowEnd:string;sampleCount:number;p50?:number|null;p95?:number|null;p99?:number|null;maximum?:number|null;dimensions?:Record<string,unknown>},context:MutationContext,pool:Pool=postgresPool()):Promise<MutationResult<ScaleMeasurement>>{
  const metricName=raw.metricName.trim();if(!/^[a-z][a-z0-9_.:-]{2,119}$/.test(metricName))throw new FoundationServiceError("VALIDATION_FAILED","Metric name is invalid.");
  const start=instant(raw.windowStart,"Measurement start");const end=instant(raw.windowEnd,"Measurement end");if(end<=start)throw new FoundationServiceError("VALIDATION_FAILED","Measurement window end must follow start.");
  if(!Number.isSafeInteger(raw.sampleCount)||raw.sampleCount<0)throw new FoundationServiceError("VALIDATION_FAILED","Sample count must be a non-negative integer.");
  const input={...raw,metricName,windowStart:start.toISOString(),windowEnd:end.toISOString(),p50:metric(raw.p50,"p50"),p95:metric(raw.p95,"p95"),p99:metric(raw.p99,"p99"),maximum:metric(raw.maximum,"maximum"),dimensions:raw.dimensions??{}};
  const operation="scale.measurement.record";const digest=requestDigest(input);
  return inTransaction(pool,async(client)=>{await establishTenantContext(client,input.workspaceId,context.actorPrincipalId);await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);const replay=await findIdempotentResult<ScaleMeasurement>(client,{workspaceId:input.workspaceId,projectId:input.projectId,principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest});if(replay)return replay;await authorizeEcosystemProjectCapability(client,{workspaceId:input.workspaceId,projectId:input.projectId,principalId:context.actorPrincipalId,capability:"scale.manage"});const id=newFolioId();const result=await client.query<MeasurementRow>(`INSERT INTO scale_measurements(id,workspace_id,project_id,component,metric_name,window_start,window_end,sample_count,p50,p95,p99,maximum,dimensions,recorded_by_principal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id,component,metric_name,window_start,window_end,sample_count,p50,p95,p99,maximum,dimensions,created_at`,[id,input.workspaceId,input.projectId,input.component,input.metricName,input.windowStart,input.windowEnd,input.sampleCount,input.p50,input.p95,input.p99,input.maximum,input.dimensions,context.actorPrincipalId]);const data=mapMeasurement(result.rows[0]!);return recordMutation(client,{workspaceId:input.workspaceId,projectId:input.projectId,context,operation,digest,action:operation,targetType:"scale_measurement",targetId:id,aggregateType:"scale_measurement",aggregateRevision:1,eventType:"scale.measurement_recorded.v1",inputSummary:{component:input.component,metricName:input.metricName,sampleCount:input.sampleCount},resultSummary:{measurementId:id,component:input.component},data});});
}

export async function listScaleMeasurements(input:{workspaceId:string;projectId:string;component?:ScaleComponent;limit?:number},principalId:string,pool:Pool=postgresPool()):Promise<ScaleMeasurement[]>{return inTransaction(pool,async(client)=>{await establishTenantContext(client,input.workspaceId,principalId);await authorizeEcosystemProjectCapability(client,{workspaceId:input.workspaceId,projectId:input.projectId,principalId,capability:"scale.read"});const limit=Math.max(1,Math.min(input.limit??200,1000));const result=await client.query<MeasurementRow>(`SELECT id,component,metric_name,window_start,window_end,sample_count,p50,p95,p99,maximum,dimensions,created_at FROM scale_measurements WHERE workspace_id=$1 AND project_id=$2 AND ($3::text IS NULL OR component=$3) ORDER BY window_end DESC,id LIMIT $4`,[input.workspaceId,input.projectId,input.component??null,limit]);return result.rows.map(mapMeasurement);});}

export async function createScaleDecision(raw:{workspaceId:string;projectId:string;component:ScaleComponent;decision:ScaleDecision["decision"];rationale:string;thresholds?:Record<string,unknown>;measurementIds?:string[]},context:MutationContext,pool:Pool=postgresPool()):Promise<MutationResult<ScaleDecision>>{
  const rationale=raw.rationale.trim();if(!rationale||rationale.length>4000)throw new FoundationServiceError("VALIDATION_FAILED","Scale decision rationale must contain 1 to 4,000 characters.");const measurementIds=[...new Set(raw.measurementIds??[])];if(measurementIds.length>100)throw new FoundationServiceError("VALIDATION_FAILED","Scale evidence is limited to 100 measurements.");if(raw.decision==="approve_extraction"&&measurementIds.length<3)throw new FoundationServiceError("CONFLICT","Extraction approval requires at least three recorded measurements.");const input={...raw,rationale,thresholds:raw.thresholds??{},measurementIds};const operation="scale.decision.create";const digest=requestDigest(input);
  return inTransaction(pool,async(client)=>{await establishTenantContext(client,input.workspaceId,context.actorPrincipalId);await lockIdempotencyKey(client,context.actorPrincipalId,operation,context.idempotencyKey);const replay=await findIdempotentResult<ScaleDecision>(client,{workspaceId:input.workspaceId,projectId:input.projectId,principalId:context.actorPrincipalId,operation,key:context.idempotencyKey,digest});if(replay)return replay;await authorizeEcosystemProjectCapability(client,{workspaceId:input.workspaceId,projectId:input.projectId,principalId:context.actorPrincipalId,capability:"scale.manage"});const evidenceRows=measurementIds.length?await client.query<{id:string;metric_name:string;p95:number|null;p99:number|null;window_end:Date}>(`SELECT id,metric_name,p95,p99,window_end FROM scale_measurements WHERE workspace_id=$1 AND project_id=$2 AND component=$3 AND id=ANY($4::uuid[])`,[input.workspaceId,input.projectId,input.component,measurementIds]):{rows:[]};if(evidenceRows.rows.length!==measurementIds.length)throw new FoundationServiceError("VALIDATION_FAILED","Scale evidence must reference measurements for the same project and component.");await client.query(`UPDATE scale_decisions SET superseded_at=now(),updated_at=now(),revision=revision+1 WHERE workspace_id=$1 AND project_id=$2 AND component=$3 AND superseded_at IS NULL`,[input.workspaceId,input.projectId,input.component]);const id=newFolioId();const evidence={measurementIds,evidence:evidenceRows.rows.map((row)=>({id:row.id,metricName:row.metric_name,p95:row.p95,p99:row.p99,windowEnd:row.window_end.toISOString()}))};const result=await client.query<DecisionRow>(`INSERT INTO scale_decisions(id,workspace_id,project_id,component,decision,rationale,thresholds,evidence,approved_by_principal_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id,component,decision,rationale,thresholds,evidence,revision,effective_at,superseded_at,created_at`,[id,input.workspaceId,input.projectId,input.component,input.decision,input.rationale,input.thresholds,evidence,context.actorPrincipalId]);const data=mapDecision(result.rows[0]!);return recordMutation(client,{workspaceId:input.workspaceId,projectId:input.projectId,context,operation,digest,action:operation,targetType:"scale_decision",targetId:id,aggregateType:"scale_decision",aggregateRevision:1,eventType:"scale.decision_created.v1",inputSummary:{component:input.component,decision:input.decision,measurementCount:measurementIds.length},resultSummary:{decisionId:id,component:input.component,decision:input.decision},data});});
}

export async function listScaleDecisions(input:{workspaceId:string;projectId:string},principalId:string,pool:Pool=postgresPool()):Promise<ScaleDecision[]>{return inTransaction(pool,async(client)=>{await establishTenantContext(client,input.workspaceId,principalId);await authorizeEcosystemProjectCapability(client,{...input,principalId,capability:"scale.read"});const result=await client.query<DecisionRow>(`SELECT id,component,decision,rationale,thresholds,evidence,revision,effective_at,superseded_at,created_at FROM scale_decisions WHERE workspace_id=$1 AND project_id=$2 ORDER BY effective_at DESC,id`,[input.workspaceId,input.projectId]);return result.rows.map(mapDecision);});}

import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { importLegacyReaderMetadata } from "@/services/legacy-import";
import { githubApiError, githubMutationContext } from "../github/response";

const schema=z.object({workspace_id:z.string().uuid(),project_id:z.string().uuid(),mappings:z.array(z.object({legacy_repository_id:z.string().min(1).max(240),repository_link_id:z.string().uuid()}).strict()).min(1).max(100)}).strict();
export const dynamic="force-dynamic";

export async function POST(request:Request){const context=requestContext(request);const authenticated=await authenticatedRequest(request,context);if(!authenticated.ok)return authenticated.response;const key=request.headers.get("idempotency-key")?.trim();if(!key)return jsonError("VALIDATION_FAILED",context,400);try{const input=schema.parse(await request.json());const result=await importLegacyReaderMetadata({workspaceId:input.workspace_id,projectId:input.project_id,mappings:input.mappings.map((mapping)=>({legacyRepositoryId:mapping.legacy_repository_id,repositoryLinkId:mapping.repository_link_id}))},githubMutationContext(authenticated.session.principalId,context,key));return jsonSuccess({legacy_import:result.data,activity_id:result.activityId,outbox_event_id:result.outboxEventId,replayed:result.replayed},context,201);}catch(error){if(error instanceof z.ZodError)return jsonError("VALIDATION_FAILED",context,400);return githubApiError(error,context);}}

import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { approveGitWriteConfirmation } from "@/services/github-write-previews";
import { githubApiError, githubMutationContext } from "../../../../github/response";

const schema=z.object({workspace_id:z.string().uuid(),project_id:z.string().uuid(),confirmation_id:z.string().uuid(),action_digest:z.string().regex(/^[a-f0-9]{64}$/),expected_revision:z.number().int().positive()}).strict();
export const dynamic="force-dynamic";

export async function POST(request:Request,{params}:{params:Promise<{preparedId:string}>}){const context=requestContext(request);const authenticated=await authenticatedRequest(request,context);if(!authenticated.ok)return authenticated.response;const key=request.headers.get("idempotency-key")?.trim();if(!key)return jsonError("VALIDATION_FAILED",context,400);try{const input=schema.parse(await request.json());const {preparedId}=await params;z.string().uuid().parse(preparedId);const result=await approveGitWriteConfirmation({workspaceId:input.workspace_id,projectId:input.project_id,confirmationId:input.confirmation_id,actionDigest:input.action_digest,expectedRevision:input.expected_revision},githubMutationContext(authenticated.session.principalId,context,key));return jsonSuccess({confirmation:result.data,activity_id:result.activityId,outbox_event_id:result.outboxEventId,replayed:result.replayed},context);}catch(error){if(error instanceof z.ZodError)return jsonError("VALIDATION_FAILED",context,400);return githubApiError(error,context);}}

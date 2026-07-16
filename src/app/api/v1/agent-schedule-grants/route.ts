import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { createAgentScheduleGrant, listAgentScheduleGrants } from "@/services/agent-scheduling";
import { mutationContext, scheduleServiceError } from "../schedule/response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const createSchema = scopeSchema.extend({ agent_principal_id: z.string().uuid(),
  list_id: z.string().uuid().nullable().optional(), calendar_id: z.string().uuid().nullable().optional(),
  operations: z.array(z.enum(["create", "reschedule", "complete", "cancel", "remind"])).min(1).max(5),
  constraints: z.record(z.string(), z.unknown()).optional(), valid_until: z.string().min(1).max(100).nullable().optional() }).strict();
export const dynamic = "force-dynamic";

const response = (item: Awaited<ReturnType<typeof listAgentScheduleGrants>>[number]) => ({
  id: item.id, agent_principal_id: item.agentPrincipalId, authorizing_principal_id: item.authorizingPrincipalId,
  list_id: item.listId, calendar_id: item.calendarId, operations: item.operations,
  constraints: item.constraints, valid_from: item.validFrom, valid_until: item.validUntil,
  revision: item.revision, created_at: item.createdAt, updated_at: item.updatedAt,
});

export async function GET(request: Request) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url); const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const agent = url.searchParams.get("agent_principal_id");
    const grants = await listAgentScheduleGrants({ workspaceId: scope.workspace_id, projectId: scope.project_id,
      agentPrincipalId: agent ? z.string().uuid().parse(agent) : undefined }, authenticated.session.principalId);
    return jsonSuccess(grants.map(response), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

export async function POST(request: Request) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response; const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const input = createSchema.parse(await request.json());
    const result = await createAgentScheduleGrant({ workspaceId: input.workspace_id, projectId: input.project_id,
      agentPrincipalId: input.agent_principal_id, listId: input.list_id, calendarId: input.calendar_id,
      operations: input.operations, constraints: input.constraints, validUntil: input.valid_until },
      mutationContext(authenticated.session.principalId, context, key));
    return jsonSuccess({ grant: response(result.data), replayed: result.replayed }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { createIntegrationConnection, listIntegrationConnections } from "@/services/calendar-providers";
import { mutationContext, scheduleServiceError } from "../schedule/response";

const scope = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const create = scope.extend({ provider_key: z.string().trim().min(2).max(40),
  display_name: z.string().trim().min(1).max(120), secret_reference: z.string().trim().min(1).max(500),
  metadata: z.record(z.string(), z.unknown()).optional() }).strict();
export const dynamic = "force-dynamic";
const response = (item: Awaited<ReturnType<typeof listIntegrationConnections>>[number]) => ({ id: item.id,
  owner_principal_id: item.ownerPrincipalId, provider_key: item.providerKey, display_name: item.displayName,
  state: item.state, capabilities: item.capabilities, metadata: item.metadata,
  last_synced_at: item.lastSyncedAt, last_error_code: item.lastErrorCode,
  revision: item.revision, created_at: item.createdAt, updated_at: item.updatedAt });

export async function GET(request: Request) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url); const input = scope.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const items = await listIntegrationConnections({ workspaceId: input.workspace_id, projectId: input.project_id }, authenticated.session.principalId);
    return jsonSuccess(items.map(response), context);
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
    const input = create.parse(await request.json()); const result = await createIntegrationConnection({
      workspaceId: input.workspace_id, projectId: input.project_id, providerKey: input.provider_key,
      displayName: input.display_name, secretReference: input.secret_reference, metadata: input.metadata },
      mutationContext(authenticated.session.principalId, context, key));
    return jsonSuccess({ connection: response(result.data), replayed: result.replayed }, context, result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

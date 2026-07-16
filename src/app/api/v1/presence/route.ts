import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { heartbeatPresence, leavePresence, listPresence } from "@/services/realtime";
import { scheduleServiceError } from "../schedule/response";

const channel = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid(),
  channel_type: z.enum(["page", "project", "calendar", "todo_list"]), channel_id: z.string().uuid() }).strict();
const heartbeat = channel.extend({ client_id: z.string().trim().min(1).max(180),
  state: z.record(z.string(), z.unknown()).optional(), ttl_seconds: z.number().int().min(15).max(300).optional() }).strict();
const leave = channel.extend({ client_id: z.string().trim().min(1).max(180) }).strict();
export const dynamic = "force-dynamic";

const response = (item: Awaited<ReturnType<typeof listPresence>>[number]) => ({ id: item.id,
  channel_type: item.channelType, channel_id: item.channelId, principal_id: item.principalId,
  display_name: item.displayName, client_id: item.clientId, state: item.state,
  connected_at: item.connectedAt, last_seen_at: item.lastSeenAt, expires_at: item.expiresAt });

export async function GET(request: Request) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url); const input = channel.parse({ workspace_id: url.searchParams.get("workspace_id"),
      project_id: url.searchParams.get("project_id"), channel_type: url.searchParams.get("channel_type"),
      channel_id: url.searchParams.get("channel_id") });
    const items = await listPresence({ workspaceId: input.workspace_id, projectId: input.project_id,
      channelType: input.channel_type, channelId: input.channel_id }, authenticated.session.principalId);
    return jsonSuccess(items.map(response), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

export async function POST(request: Request) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const input = heartbeat.parse(await request.json()); const item = await heartbeatPresence({
      workspaceId: input.workspace_id, projectId: input.project_id, channelType: input.channel_type,
      channelId: input.channel_id, clientId: input.client_id, state: input.state, ttlSeconds: input.ttl_seconds },
      authenticated.session.principalId);
    return jsonSuccess(response(item), context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

export async function DELETE(request: Request) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const input = leave.parse(await request.json()); await leavePresence({ workspaceId: input.workspace_id,
      projectId: input.project_id, channelType: input.channel_type, channelId: input.channel_id,
      clientId: input.client_id }, authenticated.session.principalId);
    return jsonSuccess({ left: true }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

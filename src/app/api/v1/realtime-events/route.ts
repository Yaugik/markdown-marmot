import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { readRealtimeEvents } from "@/services/realtime";
import { scheduleServiceError } from "../schedule/response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url); const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const topicId = url.searchParams.get("topic_id");
    const result = await readRealtimeEvents({ workspaceId: scope.workspace_id, projectId: scope.project_id,
      afterCursor: Math.max(0, Number(url.searchParams.get("after_cursor") ?? 0)),
      limit: Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? 100), 500)),
      topicType: url.searchParams.get("topic_type") ?? undefined,
      topicId: topicId ? z.string().uuid().parse(topicId) : undefined }, authenticated.session.principalId);
    return jsonSuccess({ events: result.events.map((item) => ({ cursor_id: item.cursorId, id: item.id,
      topic_type: item.topicType, topic_id: item.topicId, event_type: item.eventType,
      aggregate_revision: item.aggregateRevision, actor_principal_id: item.actorPrincipalId,
      payload: item.payload, occurred_at: item.occurredAt })), next_cursor: result.nextCursor }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

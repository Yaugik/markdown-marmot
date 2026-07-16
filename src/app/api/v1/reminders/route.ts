import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { createReminder, listMyReminders } from "@/services/reminders";
import { mutationContext, reminderResponse, scheduleServiceError } from "../schedule/response";

const scopeSchema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid() }).strict();
const createSchema = scopeSchema.extend({ todo_id: z.string().uuid().nullable().optional(),
  calendar_entry_id: z.string().uuid().nullable().optional(), recipient_principal_id: z.string().uuid(),
  remind_at: z.string().min(1).max(100), delivery_channel: z.enum(["in_app", "email", "provider"]).optional(),
  deduplication_key: z.string().trim().min(1).max(240), max_attempts: z.number().int().min(1).max(100).optional() }).strict();
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response;
  try {
    const url = new URL(request.url); const scope = scopeSchema.parse({ workspace_id: url.searchParams.get("workspace_id"), project_id: url.searchParams.get("project_id") });
    const reminders = await listMyReminders({ workspaceId: scope.workspace_id, projectId: scope.project_id,
      includeTerminal: url.searchParams.get("include_terminal") === "true" }, authenticated.session.principalId);
    return jsonSuccess(reminders.map(reminderResponse), context);
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
    const result = await createReminder({ workspaceId: input.workspace_id, projectId: input.project_id,
      todoId: input.todo_id, calendarEntryId: input.calendar_entry_id,
      recipientPrincipalId: input.recipient_principal_id, remindAt: input.remind_at,
      deliveryChannel: input.delivery_channel, deduplicationKey: input.deduplication_key,
      maxAttempts: input.max_attempts }, mutationContext(authenticated.session.principalId, context, key));
    return jsonSuccess({ reminder: reminderResponse(result.data), replayed: result.replayed }, context,
      result.replayed ? 200 : 201);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

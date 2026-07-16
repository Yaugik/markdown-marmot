import { z } from "zod";
import { authenticatedRequest, jsonError, jsonSuccess, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import { executeAgentScheduleCommand } from "@/services/agent-scheduling";
import { mutationContext, scheduleServiceError } from "../../schedule/response";

const base = z.object({ grantId: z.string().uuid() });
const commandSchema = z.discriminatedUnion("kind", [
  base.extend({ kind: z.literal("create_todo"), title: z.string().trim().min(1).max(240),
    body: z.object({ type: z.literal("doc") }).passthrough().optional(), startsAt: z.string().max(100).nullable().optional(),
    dueAt: z.string().max(100).nullable().optional(), timeZone: z.string().max(120).optional(),
    assigneePrincipalId: z.string().uuid().nullable().optional() }),
  base.extend({ kind: z.literal("reschedule_todo"), todoId: z.string().uuid(), expectedRevision: z.number().int().positive(),
    startsAt: z.string().max(100).nullable(), dueAt: z.string().max(100).nullable(), timeZone: z.string().max(120).optional() }),
  base.extend({ kind: z.enum(["complete_todo", "cancel_todo"]), todoId: z.string().uuid(), expectedRevision: z.number().int().positive() }),
  base.extend({ kind: z.literal("create_calendar_entry"), title: z.string().trim().min(1).max(240),
    body: z.object({ type: z.literal("doc") }).passthrough().optional(), startsAt: z.string().min(1).max(100),
    endsAt: z.string().min(1).max(100), timeZone: z.string().max(120).optional(), allDay: z.boolean().optional() }),
  base.extend({ kind: z.literal("reschedule_calendar_entry"), entryId: z.string().uuid(),
    expectedRevision: z.number().int().positive(), startsAt: z.string().min(1).max(100),
    endsAt: z.string().min(1).max(100), timeZone: z.string().max(120).optional() }),
  base.extend({ kind: z.literal("create_reminder"), todoId: z.string().uuid().optional(),
    calendarEntryId: z.string().uuid().optional(), recipientPrincipalId: z.string().uuid(),
    remindAt: z.string().min(1).max(100), deduplicationKey: z.string().trim().min(1).max(240) }),
]);
const schema = z.object({ workspace_id: z.string().uuid(), project_id: z.string().uuid(),
  authorizing_principal_id: z.string().uuid(), command: commandSchema }).strict();
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const context = requestContext(request); const authenticated = await authenticatedRequest(request, context);
  if (!authenticated.ok) return authenticated.response; const key = request.headers.get("idempotency-key")?.trim();
  if (!key) return jsonError("VALIDATION_FAILED", context, 400);
  try {
    const input = schema.parse(await request.json());
    const baseContext = mutationContext(authenticated.session.principalId, context, key, input.authorizing_principal_id);
    const result = await executeAgentScheduleCommand({ workspaceId: input.workspace_id,
      projectId: input.project_id, command: input.command }, { ...baseContext, source: "agent" as const });
    return jsonSuccess({ result: { kind: result.data.kind, target_id: result.data.targetId,
      revision: result.data.revision, grant_id: result.data.grantId }, replayed: result.replayed }, context);
  } catch (error) {
    if (error instanceof z.ZodError) return jsonError("VALIDATION_FAILED", context, 400);
    if (error instanceof FoundationServiceError) return scheduleServiceError(error, context);
    return jsonError("OPERATION_FAILED", context, 500);
  }
}

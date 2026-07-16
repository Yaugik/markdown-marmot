import { jsonError, requestContext } from "@/api";
import { FoundationServiceError } from "@/services/foundation";
import type { TodoList } from "@/services/todo-lists";
import type { Todo } from "@/services/todos";
import type { Calendar, CalendarEntry } from "@/services/calendars";
import type { Reminder } from "@/services/reminders";

export const listResponse = (item: TodoList) => ({
  id: item.id,
  workspace_id: item.workspaceId,
  project_id: item.projectId,
  owner_principal_id: item.ownerPrincipalId,
  name: item.name,
  visibility: item.visibility,
  revision: item.revision,
  created_at: item.createdAt,
  updated_at: item.updatedAt,
  archived_at: item.archivedAt,
});

export const todoResponse = (item: Todo) => ({
  id: item.id,
  workspace_id: item.workspaceId,
  project_id: item.projectId,
  list_id: item.listId,
  parent_todo_id: item.parentTodoId,
  title: item.title,
  body: item.body,
  plain_text: item.plainText,
  status: item.status,
  assignee: item.assignee ? {
    principal_id: item.assignee.principalId,
    display_name: item.assignee.displayName,
    kind: item.assignee.kind,
  } : null,
  starts_at: item.startsAt,
  due_at: item.dueAt,
  time_zone: item.timeZone,
  rank: item.rank,
  revision: item.revision,
  completed_at: item.completedAt,
  created_at: item.createdAt,
  updated_at: item.updatedAt,
  archived_at: item.archivedAt,
});

export const calendarResponse = (item: Calendar) => ({
  id: item.id,
  workspace_id: item.workspaceId,
  project_id: item.projectId,
  owner_principal_id: item.ownerPrincipalId,
  name: item.name,
  visibility: item.visibility,
  time_zone: item.timeZone,
  revision: item.revision,
  created_at: item.createdAt,
  updated_at: item.updatedAt,
  archived_at: item.archivedAt,
});

export const entryResponse = (item: CalendarEntry) => ({
  id: item.id,
  calendar_id: item.calendarId,
  source_kind: item.sourceKind,
  todo_id: item.todoId,
  issue_id: item.issueId,
  title: item.title,
  body: item.body,
  plain_text: item.plainText,
  starts_at: item.startsAt,
  ends_at: item.endsAt,
  all_day: item.allDay,
  time_zone: item.timeZone,
  revision: item.revision,
  created_at: item.createdAt,
  updated_at: item.updatedAt,
  archived_at: item.archivedAt,
});

export const reminderResponse = (item: Reminder) => ({
  id: item.id,
  todo_id: item.todoId,
  calendar_entry_id: item.calendarEntryId,
  recipient_principal_id: item.recipientPrincipalId,
  remind_at: item.remindAt,
  state: item.state,
  delivery_channel: item.deliveryChannel,
  attempt_count: item.attemptCount,
  max_attempts: item.maxAttempts,
  available_at: item.availableAt,
  sent_at: item.sentAt,
  created_at: item.createdAt,
  updated_at: item.updatedAt,
});

function revisionDetail(value: unknown): string | number | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

export function scheduleServiceError(
  error: FoundationServiceError,
  context: ReturnType<typeof requestContext>,
) {
  const status = error.code === "NOT_FOUND" ? 404
    : error.code === "CAPABILITY_DENIED" ? 403
      : ["CONFLICT", "IDEMPOTENCY_CONFLICT", "REVISION_CONFLICT"].includes(error.code) ? 409
        : 400;
  const details = error.code === "REVISION_CONFLICT" ? {
    expected_revision: revisionDetail(error.details.expectedRevision),
    current_revision: revisionDetail(error.details.currentRevision),
  } : Object.keys(error.details).length ? error.details : undefined;
  return jsonError(error.code, context, status, { details });
}

export function mutationContext(
  principalId: string,
  context: ReturnType<typeof requestContext>,
  idempotencyKey: string,
  authorizingPrincipalId?: string,
) {
  return {
    actorPrincipalId: principalId,
    authorizingPrincipalId,
    requestId: context.requestId,
    traceId: context.traceId,
    idempotencyKey,
    source: "api" as const,
  };
}

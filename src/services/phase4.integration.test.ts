import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { newFolioId } from "@/lib/folio-ids";
import { createProject, createWorkspace, provisionAuthenticatedHuman } from "@/services/foundation";
import { createAuthorizedCalendarEntry } from "@/services/calendar-entry-commands";
import { calendarView, createCalendar, listCalendarEntries } from "@/services/calendars";
import { createReminder, finishReminderAttempt, claimDueReminders } from "@/services/reminders";
import { readRealtimeEvents } from "@/services/realtime";
import { createTodoList, listTodoLists } from "@/services/todo-lists";
import { ensureTodoOccurrences, materializeDueTodoOccurrences, setTodoRecurrence } from "@/services/todo-recurrence";
import { archiveTodo, createTodo, readTodo, restoreTodo } from "@/services/todos";

const databaseUrl = process.env.DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const doc = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describeWithPostgres("Phase 4 scheduling", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  afterAll(async () => { await pool.end(); });

  it("keeps private schedules private while supporting hierarchy recurrence reminders and mixed calendars", async () => {
    const suffix = newFolioId();
    const owner = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `phase4-owner-${suffix}`,
      email: `phase4-owner-${suffix}@example.test`,
      displayName: "Phase 4 Owner",
    }, pool);
    const reviewer = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `phase4-reviewer-${suffix}`,
      email: `phase4-reviewer-${suffix}@example.test`,
      displayName: "Phase 4 Reviewer",
    }, pool);
    const context = (key: string, actor = owner.principalId) => ({
      actorPrincipalId: actor,
      requestId: newFolioId(),
      traceId: `phase4-${suffix}`,
      idempotencyKey: `${key}-${suffix}`,
      source: "api" as const,
    });
    const workspace = await createWorkspace({
      name: "Phase 4 Workspace",
      slug: `phase4-${suffix}`,
    }, context("workspace"), pool);
    const project = await createProject({
      workspaceId: workspace.data.id,
      projectKey: "PLAN",
      name: "Scheduling",
    }, context("project"), pool);

    const adminRole = await pool.query<{ id: string }>(`
      SELECT id FROM role_templates
      WHERE workspace_id=$1 AND template_key='admin'
    `, [workspace.data.id]);
    await pool.query(`
      INSERT INTO workspace_memberships(
        id,workspace_id,principal_id,role,status,invited_by_principal_id
      ) VALUES($1,$2,$3,'member','active',$4)
    `, [newFolioId(),workspace.data.id,reviewer.principalId,owner.principalId]);
    await pool.query(`
      INSERT INTO project_memberships(
        id,workspace_id,project_id,principal_id,role_template_id,status,invited_by_principal_id
      ) VALUES($1,$2,$3,$4,$5,'active',$6)
    `, [newFolioId(),workspace.data.id,project.data.id,reviewer.principalId,
      adminRole.rows[0]!.id,owner.principalId]);

    const agentId = newFolioId();
    const agentRoleId = newFolioId();
    await pool.query(`
      INSERT INTO principals(id,kind,display_name,status)
      VALUES($1,'agent','Planning Agent','active')
    `, [agentId]);
    await pool.query(`
      INSERT INTO role_templates(
        id,workspace_id,name,template_key,capabilities,is_system_template
      ) VALUES($1,$2,'Scheduling Agent',$3,ARRAY['schedule.execute']::text[],false)
    `, [agentRoleId,workspace.data.id,`scheduling_agent_${suffix.slice(0, 8)}`]);
    await pool.query(`
      INSERT INTO workspace_memberships(
        id,workspace_id,principal_id,role,status,invited_by_principal_id
      ) VALUES($1,$2,$3,'member','active',$4)
    `, [newFolioId(),workspace.data.id,agentId,owner.principalId]);
    await pool.query(`
      INSERT INTO project_memberships(
        id,workspace_id,project_id,principal_id,role_template_id,status,invited_by_principal_id
      ) VALUES($1,$2,$3,$4,$5,'active',$6)
    `, [newFolioId(),workspace.data.id,project.data.id,agentId,agentRoleId,owner.principalId]);

    const list = await createTodoList({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      name: "Private launch",
      visibility: "private",
    }, context("list"), pool);
    expect(await listTodoLists({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
    }, reviewer.principalId, pool)).toEqual([]);

    const parent = await createTodo({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      listId: list.data.id,
      title: "Prepare launch",
      body: doc("Sensitive launch checklist must not enter realtime payloads"),
      assigneePrincipalId: agentId,
      startsAt: "2026-07-16T09:00:00.000Z",
      dueAt: "2026-07-16T10:00:00.000Z",
      timeZone: "UTC",
    }, context("parent"), pool);
    const child = await createTodo({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      listId: list.data.id,
      parentTodoId: parent.data.id,
      title: "Send announcement",
    }, context("child"), pool);
    expect(parent.data.assignee).toMatchObject({ principalId: agentId, kind: "agent" });
    await expect(archiveTodo({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      todoId: parent.data.id,
      expectedRevision: parent.data.revision,
    }, context("archive-parent-blocked"), pool)).rejects.toMatchObject({ code: "CONFLICT" });
    const archivedChild = await archiveTodo({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      todoId: child.data.id,
      expectedRevision: child.data.revision,
    }, context("archive-child"), pool);
    const archivedParent = await archiveTodo({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      todoId: parent.data.id,
      expectedRevision: parent.data.revision,
    }, context("archive-parent"), pool);
    await expect(restoreTodo({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      todoId: child.data.id,
      expectedRevision: archivedChild.data.revision,
    }, context("restore-child-blocked"), pool)).rejects.toMatchObject({ code: "CONFLICT" });
    const restoredParent = await restoreTodo({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      todoId: parent.data.id,
      expectedRevision: archivedParent.data.revision,
    }, context("restore-parent"), pool);
    await restoreTodo({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      todoId: child.data.id,
      expectedRevision: archivedChild.data.revision,
    }, context("restore-child"), pool);

    await pool.query(`
      INSERT INTO object_grants(
        id,workspace_id,project_id,principal_id,object_type,object_id,
        capabilities,granted_by_principal_id
      ) VALUES($1,$2,$3,$4,'todo_list',$5,ARRAY['todo.read']::text[],$6)
    `, [newFolioId(),workspace.data.id,project.data.id,reviewer.principalId,
      list.data.id,owner.principalId]);
    expect((await listTodoLists({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
    }, reviewer.principalId, pool)).map((item) => item.id)).toEqual([list.data.id]);
    expect((await readTodo({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      todoId: parent.data.id,
    }, reviewer.principalId, pool)).title).toBe("Prepare launch");

    const recurring = await createTodo({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      listId: list.data.id,
      title: "Daily standup",
      startsAt: "2026-07-16T03:30:00.000Z",
      dueAt: "2026-07-16T04:00:00.000Z",
      timeZone: "Asia/Kolkata",
    }, context("recurring"), pool);
    const rule = await setTodoRecurrence({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      todoId: recurring.data.id,
      expectedTodoRevision: recurring.data.revision,
      frequency: "daily",
      localTime: "09:00",
      timeZone: "Asia/Kolkata",
      startsOn: "2026-07-16",
      countLimit: 2,
    }, context("recurrence"), pool);
    const occurrencesA = await ensureTodoOccurrences({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      todoId: recurring.data.id,
      windowStart: "2026-07-16",
      windowEnd: "2026-07-20",
    }, owner.principalId, pool);
    const occurrencesB = await ensureTodoOccurrences({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      todoId: recurring.data.id,
      windowStart: "2026-07-16",
      windowEnd: "2026-07-20",
    }, owner.principalId, pool);
    expect(occurrencesA.map((item) => item.id)).toEqual(occurrencesB.map((item) => item.id));
    expect(occurrencesA).toHaveLength(2);
    expect(rule.data.todoId).toBe(recurring.data.id);
    const materialized = await materializeDueTodoOccurrences({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      through: "2026-07-17T12:00:00.000Z",
      limit: 10,
    }, owner.principalId, pool);
    expect(materialized.materialized).toHaveLength(2);
    const repeated = await materializeDueTodoOccurrences({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      through: "2026-07-17T12:00:00.000Z",
      limit: 10,
    }, owner.principalId, pool);
    expect(repeated.materialized).toEqual([]);

    const calendar = await createCalendar({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      name: "Private calendar",
      visibility: "private",
      timeZone: "UTC",
    }, context("calendar"), pool);
    const entry = await createAuthorizedCalendarEntry({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      calendarId: calendar.data.id,
      title: "Launch review",
      startsAt: "2026-07-20T09:00:00.000Z",
      endsAt: "2026-07-20T10:00:00.000Z",
      timeZone: "UTC",
    }, context("entry"), pool);
    expect(await calendarView({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      from: "2026-07-19T00:00:00.000Z",
      to: "2026-07-21T00:00:00.000Z",
    }, reviewer.principalId, pool)).toEqual([]);
    await pool.query(`
      INSERT INTO object_grants(
        id,workspace_id,project_id,principal_id,object_type,object_id,
        capabilities,granted_by_principal_id
      ) VALUES($1,$2,$3,$4,'calendar',$5,ARRAY['calendar.read']::text[],$6)
    `, [newFolioId(),workspace.data.id,project.data.id,reviewer.principalId,
      calendar.data.id,owner.principalId]);
    expect((await listCalendarEntries({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      calendarId: calendar.data.id,
      from: "2026-07-19T00:00:00.000Z",
      to: "2026-07-21T00:00:00.000Z",
    }, reviewer.principalId, pool)).map((item) => item.id)).toEqual([entry.data.id]);

    const reminder = await createReminder({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      todoId: restoredParent.data.id,
      recipientPrincipalId: owner.principalId,
      remindAt: "2020-01-01T00:00:00.000Z",
      deduplicationKey: `phase4-reminder-${suffix}`,
    }, context("reminder"), pool);
    const claimed = await claimDueReminders({
      workspaceId: workspace.data.id,
      workerId: `phase4-worker-${suffix}`,
      limit: 10,
    }, pool);
    expect(claimed.map((item) => item.id)).toContain(reminder.data.id);
    const delivered = await finishReminderAttempt({
      workspaceId: workspace.data.id,
      reminderId: reminder.data.id,
      workerId: `phase4-worker-${suffix}`,
      success: true,
    }, pool);
    expect(delivered.state).toBe("sent");

    const beforeGrantEvents = await readRealtimeEvents({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      afterCursor: 0,
      limit: 500,
      topicType: "todo",
      topicId: recurring.data.id,
    }, reviewer.principalId, pool);
    expect(beforeGrantEvents.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(beforeGrantEvents.events)).not.toContain("Sensitive launch checklist");
  });
});

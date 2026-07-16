import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { newFolioId } from "@/lib/folio-ids";
import { createCalendar, listCalendarEntries } from "@/services/calendars";
import {
  createCalendarExternalBinding,
  createIntegrationConnection,
  enqueueCalendarProviderOperation,
  registerCalendarProviderAdapter,
} from "@/services/calendar-providers";
import { runCalendarProviderOperation } from "@/services/calendar-provider-worker";
import { claimDurableJobs, enqueueDurableJob, finishDurableJob } from "@/services/durable-jobs";
import { createProject, createWorkspace, provisionAuthenticatedHuman } from "@/services/foundation";
import { heartbeatPresence, leavePresence, listPresence, readRealtimeEvents } from "@/services/realtime";

const databaseUrl = process.env.DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("Phase 5 scheduling foundations", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  afterAll(async () => { await pool.end(); });

  it("leases durable jobs and reconciles provider events through a permission-filtered cursor", async () => {
    const suffix = newFolioId();
    const owner = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `phase5-owner-${suffix}`,
      email: `phase5-owner-${suffix}@example.test`,
      displayName: "Phase 5 Owner",
    }, pool);
    const context = (key: string) => ({
      actorPrincipalId: owner.principalId,
      requestId: newFolioId(),
      traceId: `phase5-${suffix}`,
      idempotencyKey: `${key}-${suffix}`,
      source: "api" as const,
    });
    const workspace = await createWorkspace({
      name: "Phase 5 Workspace",
      slug: `phase5-${suffix}`,
    }, context("workspace"), pool);
    const project = await createProject({
      workspaceId: workspace.data.id,
      projectKey: "SYNC",
      name: "Provider Foundations",
    }, context("project"), pool);
    const calendar = await createCalendar({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      name: "Provider calendar",
      visibility: "private",
      timeZone: "UTC",
    }, context("calendar"), pool);

    const kind = `phase5.test.${suffix}`;
    const jobId = await enqueueDurableJob({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      kind,
      payload: { value: 1 },
      deduplicationKey: `phase5-job-${suffix}`,
      maxAttempts: 3,
    }, pool);
    const firstClaim = await claimDurableJobs({
      workerId: `worker-a-${suffix}`,
      kinds: [kind],
      limit: 1,
    }, pool);
    expect(firstClaim.map((job) => job.id)).toEqual([jobId]);
    const retried = await finishDurableJob({
      jobId,
      workerId: `worker-a-${suffix}`,
      success: false,
      errorCode: "TRANSIENT",
      errorMessage: "retry me",
      retryable: true,
    }, pool);
    expect(retried.status).toBe("pending");
    await pool.query(`UPDATE jobs SET available_at=now() WHERE id=$1`, [jobId]);
    const secondClaim = await claimDurableJobs({
      workerId: `worker-b-${suffix}`,
      kinds: [kind],
      limit: 1,
    }, pool);
    expect(secondClaim[0]).toMatchObject({ id: jobId, attemptCount: 2 });
    const completed = await finishDurableJob({
      jobId,
      workerId: `worker-b-${suffix}`,
      success: true,
      result: { ok: true },
    }, pool);
    expect(completed.status).toBe("succeeded");
    const attempts = await pool.query<{ state: string }>(`
      SELECT state FROM job_attempts WHERE job_id=$1 ORDER BY attempt_number
    `, [jobId]);
    expect(attempts.rows.map((row) => row.state)).toEqual(["failed", "succeeded"]);

    const providerKey = `test_${suffix.slice(0, 8)}`;
    registerCalendarProviderAdapter({
      key: providerKey,
      capabilities: new Set(["discover", "pull"]),
      async discoverCalendars() {
        return {
          calendars: [{ externalId: "external-calendar", name: "External", timeZone: "UTC" }],
          cursor: "discover-1",
        };
      },
      async pullEvents() {
        return {
          cursor: "pull-1",
          events: [{
            externalId: "external-event-1",
            etag: "etag-1",
            title: "Imported provider event",
            startsAt: "2026-08-01T09:00:00.000Z",
            endsAt: "2026-08-01T10:00:00.000Z",
            allDay: false,
            timeZone: "UTC",
            updatedAt: "2026-07-16T12:00:00.000Z",
            deleted: false,
          }],
        };
      },
    });
    const connection = await createIntegrationConnection({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      providerKey,
      displayName: "Test provider",
      secretReference: `secret://phase5/${suffix}`,
    }, context("connection"), pool);
    expect(connection.data.state).toBe("active");
    await expect(createCalendarExternalBinding({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      calendarId: calendar.data.id,
      connectionId: connection.data.id,
      externalCalendarId: "external-calendar",
      direction: "two_way",
      conflictPolicy: "manual",
    }, context("two-way-rejected"), pool)).rejects.toMatchObject({ code: "CONFLICT" });
    const binding = await createCalendarExternalBinding({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      calendarId: calendar.data.id,
      connectionId: connection.data.id,
      externalCalendarId: "external-calendar",
      direction: "pull",
      conflictPolicy: "manual",
    }, context("binding"), pool);
    const operation = await enqueueCalendarProviderOperation({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      connectionId: connection.data.id,
      bindingId: binding.data.id,
      operation: "pull",
    }, context("pull"), pool);
    const summary = await runCalendarProviderOperation(operation.data.operationId, pool);
    expect(summary).toMatchObject({ created: 1, updated: 0, deleted: 0 });
    const entries = await listCalendarEntries({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      calendarId: calendar.data.id,
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
    }, owner.principalId, pool);
    expect(entries).toEqual([
      expect.objectContaining({ title: "Imported provider event", sourceKind: "external" }),
    ]);
    await runCalendarProviderOperation((await enqueueCalendarProviderOperation({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      connectionId: connection.data.id,
      bindingId: binding.data.id,
      operation: "pull",
    }, context("pull-again"), pool)).data.operationId, pool);
    expect((await listCalendarEntries({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      calendarId: calendar.data.id,
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
    }, owner.principalId, pool))).toHaveLength(1);

    const presence = await heartbeatPresence({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      channelType: "calendar",
      channelId: calendar.data.id,
      clientId: `client-${suffix}`,
      state: { view: "month" },
      ttlSeconds: 60,
    }, owner.principalId, pool);
    expect((await listPresence({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      channelType: "calendar",
      channelId: calendar.data.id,
    }, owner.principalId, pool)).map((item) => item.id)).toEqual([presence.id]);
    await leavePresence({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      channelType: "calendar",
      channelId: calendar.data.id,
      clientId: `client-${suffix}`,
    }, owner.principalId, pool);
    expect(await listPresence({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      channelType: "calendar",
      channelId: calendar.data.id,
    }, owner.principalId, pool)).toEqual([]);

    const events = await readRealtimeEvents({
      workspaceId: workspace.data.id,
      projectId: project.data.id,
      afterCursor: 0,
      limit: 500,
      topicType: "calendar_entry",
      topicId: entries[0]!.id,
    }, owner.principalId, pool);
    expect(events.events).toEqual([
      expect.objectContaining({ eventType: "calendar_entry.external_reconciled.v1" }),
      expect.objectContaining({ eventType: "calendar_entry.external_reconciled.v1" }),
    ]);
  });
});

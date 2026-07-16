import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { newFolioId } from "@/lib/folio-ids";
import { provisionAuthenticatedHuman } from "./identity";
import { createProject } from "./projects";
import { listPermittedProjects, listPermittedWorkspaces } from "./queries";
import { createWorkspace } from "./workspaces";

const databaseUrl = process.env.DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("foundation application services", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  afterAll(async () => {
    await pool.end();
  });

  it("provisions an OIDC human once under concurrent-safe natural identity", async () => {
    const suffix = newFolioId();
    const input = {
      issuer: "https://identity.example.test",
      subject: `subject-${suffix}`,
      email: `${suffix}@example.test`,
      displayName: "Foundation User",
    };
    const first = await provisionAuthenticatedHuman(input, pool);
    const second = await provisionAuthenticatedHuman(input, pool);

    expect(second).toEqual(first);
    const counts = await pool.query<{ users: string; identities: string; principals: string }>(`
      SELECT
        (SELECT count(*) FROM users WHERE id = $1)::text users,
        (SELECT count(*) FROM external_identities WHERE user_id = $1)::text identities,
        (SELECT count(*) FROM principals WHERE user_id = $1)::text principals
    `, [first.userId]);
    expect(counts.rows[0]).toEqual({ users: "1", identities: "1", principals: "1" });
  });

  it("creates an audited workspace and project and replays both idempotently", async () => {
    const suffix = newFolioId();
    const human = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `owner-${suffix}`,
      email: `owner-${suffix}@example.test`,
      displayName: "Workspace Owner",
    }, pool);
    const workspaceContext = {
      actorPrincipalId: human.principalId,
      requestId: newFolioId(),
      traceId: `trace-${suffix}`,
      idempotencyKey: `workspace-${suffix}`,
      source: "api" as const,
    };
    const workspaceInput = {
      name: "Folio Test Workspace",
      slug: `folio-${suffix}`,
      defaultTimeZone: "Asia/Kolkata",
    };
    const workspace = await createWorkspace(workspaceInput, workspaceContext, pool);
    const workspaceReplay = await createWorkspace(workspaceInput, {
      ...workspaceContext,
      requestId: newFolioId(),
    }, pool);

    expect(workspace.replayed).toBe(false);
    expect(workspaceReplay).toMatchObject({
      data: workspace.data,
      activityId: workspace.activityId,
      outboxEventId: workspace.outboxEventId,
      replayed: true,
    });
    const roles = await pool.query<{ template_key: string; is_system_template: boolean }>(`
      SELECT template_key, is_system_template
      FROM role_templates WHERE workspace_id = $1 ORDER BY template_key
    `, [workspace.data.id]);
    expect(roles.rows).toEqual([
      { template_key: "admin", is_system_template: true },
      { template_key: "guest", is_system_template: true },
      { template_key: "member", is_system_template: true },
    ]);

    const projectContext = {
      ...workspaceContext,
      requestId: newFolioId(),
      idempotencyKey: `project-${suffix}`,
    };
    const projectInput = {
      workspaceId: workspace.data.id,
      projectKey: "FOLIO",
      name: "Folio",
    };
    const project = await createProject(projectInput, projectContext, pool);
    const projectReplay = await createProject(projectInput, {
      ...projectContext,
      requestId: newFolioId(),
    }, pool);

    expect(project.replayed).toBe(false);
    expect(project.data.roleTemplateKey).toBe("admin");
    expect(project.data.capabilities).toContain("project.members.manage");
    expect(projectReplay).toMatchObject({
      data: project.data,
      activityId: project.activityId,
      outboxEventId: project.outboxEventId,
      replayed: true,
    });
    expect(await listPermittedWorkspaces(human.principalId, pool)).toContainEqual(workspace.data);
    expect(await listPermittedProjects(human.principalId, workspace.data.id, pool)).toContainEqual(project.data);

    const records = await pool.query<{ activities: string; events: string; idempotency: string }>(`
      SELECT
        (SELECT count(*) FROM activity_events WHERE workspace_id = $1)::text activities,
        (SELECT count(*) FROM outbox_events WHERE workspace_id = $1)::text events,
        (SELECT count(*) FROM idempotency_records WHERE workspace_id = $1)::text idempotency
    `, [workspace.data.id]);
    expect(records.rows[0]).toEqual({ activities: "2", events: "2", idempotency: "2" });
  });

  it("rejects an idempotency key reused with different input", async () => {
    const suffix = newFolioId();
    const human = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `conflict-${suffix}`,
      email: `conflict-${suffix}@example.test`,
      displayName: "Conflict User",
    }, pool);
    const context = {
      actorPrincipalId: human.principalId,
      requestId: newFolioId(),
      traceId: `trace-${suffix}`,
      idempotencyKey: `same-${suffix}`,
    };
    await createWorkspace({ name: "First", slug: `first-${suffix}` }, context, pool);
    await expect(createWorkspace(
      { name: "Second", slug: `second-${suffix}` },
      { ...context, requestId: newFolioId() },
      pool,
    )).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
});

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { createAuthSession, serializeSessionCookie } from "@/auth/sessions";
import { newFolioId } from "@/lib/folio-ids";
import { provisionAuthenticatedHuman } from "@/services/foundation";
import { GET as listWorkspaces, POST as createWorkspace } from "./workspaces/route";
import { GET as listProjects, POST as createProject } from "./projects/route";

const databaseUrl = process.env.DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("authenticated foundation routes", () => {
  const pool = new Pool({ connectionString: databaseUrl });

  afterAll(async () => {
    await pool.end();
  });

  it("requires a session and creates an idempotent workspace and project", async () => {
    const suffix = newFolioId();
    const unauthenticated = await listWorkspaces(new Request("https://folio.test/api/v1/workspaces"));
    expect(unauthenticated.status).toBe(401);

    const human = await provisionAuthenticatedHuman({
      issuer: "https://identity.example.test",
      subject: `route-${suffix}`,
      email: `route-${suffix}@example.test`,
      displayName: "Route User",
    }, pool);
    const client = await pool.connect();
    const session = await createAuthSession(client, { userId: human.userId, principalId: human.principalId });
    client.release();
    const cookie = serializeSessionCookie(session.token, session.expiresAt).split(";")[0];
    const mutationHeaders = {
      cookie,
      origin: "https://folio.test",
      "content-type": "application/json",
      "idempotency-key": `workspace-${suffix}`,
    };

    const workspaceResponse = await createWorkspace(new Request("https://folio.test/api/v1/workspaces", {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ name: "Route Workspace", slug: `route-${suffix}` }),
    }));
    expect(workspaceResponse.status).toBe(201);
    const workspaceBody = await workspaceResponse.json() as { data: { workspace: { id: string } } };

    const workspaceReplay = await createWorkspace(new Request("https://folio.test/api/v1/workspaces", {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ name: "Route Workspace", slug: `route-${suffix}` }),
    }));
    expect(workspaceReplay.status).toBe(200);
    await expect(workspaceReplay.json()).resolves.toMatchObject({ data: { replayed: true } });

    const projectResponse = await createProject(new Request("https://folio.test/api/v1/projects", {
      method: "POST",
      headers: { ...mutationHeaders, "idempotency-key": `project-${suffix}` },
      body: JSON.stringify({
        workspace_id: workspaceBody.data.workspace.id,
        project_key: "ROUTE",
        name: "Route Project",
      }),
    }));
    expect(projectResponse.status).toBe(201);

    const workspaceList = await listWorkspaces(new Request("https://folio.test/api/v1/workspaces", { headers: { cookie } }));
    const listedWorkspaces = await workspaceList.json() as { data: Array<{ id: string }> };
    expect(listedWorkspaces.data.some((workspace) => workspace.id === workspaceBody.data.workspace.id)).toBe(true);
    const projectList = await listProjects(new Request(`https://folio.test/api/v1/projects?workspace_id=${workspaceBody.data.workspace.id}`, { headers: { cookie } }));
    const listedProjects = await projectList.json() as { data: Array<{ project_key: string }> };
    expect(listedProjects.data.some((project) => project.project_key === "ROUTE")).toBe(true);
  });
});

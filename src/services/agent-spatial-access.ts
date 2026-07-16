import type { Pool, PoolClient } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import type { ProjectCapability } from "@/auth/capabilities";
import {
  authorizeEcosystemProjectCapability,
  authorizeGraphEntityRead,
  authorizeOwnedEcosystemObject,
  readCanvasPolicy,
  type GraphEntityType,
} from "@/services/ecosystem-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";
import { authorizeScheduleObject, readTodoListPolicy } from "@/services/schedule-access";

export type AgentActorChain = {
  workspaceId: string;
  projectId: string;
  agentPrincipalId: string;
  authorizingPrincipalId: string;
};

async function assertPrincipalKinds(client: PoolClient, input: AgentActorChain) {
  const result = await client.query<{ id: string; kind: string; status: string }>(`
    SELECT id,kind,status FROM principals WHERE id=ANY($1::uuid[])
  `, [[input.agentPrincipalId,input.authorizingPrincipalId]]);
  const agent = result.rows.find((row) => row.id === input.agentPrincipalId);
  const authorizer = result.rows.find((row) => row.id === input.authorizingPrincipalId);
  if (!agent || agent.kind !== "agent" || agent.status !== "active") {
    throw new FoundationServiceError("CAPABILITY_DENIED", "An active project agent principal is required.");
  }
  if (!authorizer || authorizer.kind !== "human" || authorizer.status !== "active") {
    throw new FoundationServiceError("CAPABILITY_DENIED", "An active human authorizer is required.");
  }
  await authorizeEcosystemProjectCapability(client, { ...input, principalId: input.authorizingPrincipalId, capability: "agent.invoke" });
}

export async function authorizeAgentProjectCapability(
  input: AgentActorChain & { capability: ProjectCapability },
  pool: Pool = postgresPool(),
): Promise<void> {
  await inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, input.agentPrincipalId);
    await assertPrincipalKinds(client, input);
    await authorizeEcosystemProjectCapability(client, { ...input, principalId: input.agentPrincipalId, capability: input.capability });
    await authorizeEcosystemProjectCapability(client, { ...input, principalId: input.authorizingPrincipalId, capability: input.capability });
  });
}

export async function authorizeAgentCanvasCapability(
  input: AgentActorChain & { canvasId: string; capability: "canvas.read" | "canvas.edit" | "canvas.comment" | "canvas.present" },
  pool: Pool = postgresPool(),
): Promise<void> {
  await inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, input.agentPrincipalId);
    await assertPrincipalKinds(client, input);
    const policy = await readCanvasPolicy(client, { workspaceId: input.workspaceId, projectId: input.projectId, canvasId: input.canvasId });
    for (const principalId of [input.agentPrincipalId,input.authorizingPrincipalId]) {
      await authorizeOwnedEcosystemObject(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        principalId,
        capability: input.capability,
        objectType: "canvas",
        objectId: input.canvasId,
        ownerPrincipalId: policy.ownerPrincipalId,
        visibility: policy.visibility,
      });
    }
  });
}

export async function authorizeAgentEntityRead(
  input: AgentActorChain & { entityType: GraphEntityType; entityId: string },
  pool: Pool = postgresPool(),
): Promise<void> {
  await inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, input.agentPrincipalId);
    await assertPrincipalKinds(client, input);
    for (const principalId of [input.agentPrincipalId,input.authorizingPrincipalId]) {
      await authorizeGraphEntityRead(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        principalId,
        entityType: input.entityType,
        entityId: input.entityId,
      });
    }
  });
}

export async function authorizeAgentTodoListEdit(
  input: AgentActorChain & { listId: string },
  pool: Pool = postgresPool(),
): Promise<void> {
  await inTransaction(pool, async (client) => {
    await establishTenantContext(client, input.workspaceId, input.agentPrincipalId);
    await assertPrincipalKinds(client, input);
    const policy = await readTodoListPolicy(client, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      listId: input.listId,
    });
    for (const principalId of [input.agentPrincipalId,input.authorizingPrincipalId]) {
      await authorizeScheduleObject(client, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        principalId,
        capability: "todo.edit",
        objectType: "todo_list",
        objectId: input.listId,
        ownerPrincipalId: policy.ownerPrincipalId,
        visibility: policy.visibility,
      });
    }
  });
}

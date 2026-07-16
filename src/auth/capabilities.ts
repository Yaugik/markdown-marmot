export const projectCapabilities = [
  "project.read",
  "project.update",
  "project.members.manage",
  "project.grants.manage",
  "repository.read",
  "repository.manage",
  "repository.reconcile",
  "repository.branch.create",
  "repository.markdown.prepare",
  "repository.markdown.commit",
  "repository.pull_request.open",
  "page.read",
  "page.create",
  "page.edit",
  "page.comment",
  "page.archive",
  "page.collaborate",
  "issue.read",
  "issue.create",
  "issue.edit",
  "issue.transition",
  "issue.comment",
  "issue.archive",
  "todo.read",
  "todo.create",
  "todo.edit",
  "todo.archive",
  "calendar.read",
  "calendar.create",
  "calendar.edit",
  "calendar.archive",
  "schedule.delegate",
  "schedule.execute",
  "realtime.read",
  "presence.write",
  "integration.read",
  "integration.manage",
  "scale.read",
  "scale.manage",
  "identity.manage",
  "residency.manage",
  "audit.export",
  "support_access.manage",
  "relationship.read",
  "relationship.edit",
  "graph.read",
  "graph.manage",
  "canvas.read",
  "canvas.create",
  "canvas.edit",
  "canvas.comment",
  "canvas.present",
  "agent.read",
  "agent.invoke",
  "agent.manage",
  "activity.read",
] as const;

export type ProjectCapability = typeof projectCapabilities[number];
export type ProjectRole = "admin" | "member" | "guest";

export const defaultProjectRoleCapabilities: Record<ProjectRole, ReadonlySet<ProjectCapability>> = {
  admin: new Set(projectCapabilities),
  member: new Set([
    "project.read",
    "repository.read",
    "repository.reconcile",
    "repository.branch.create",
    "repository.markdown.prepare",
    "repository.markdown.commit",
    "repository.pull_request.open",
    "page.read",
    "page.create",
    "page.edit",
    "page.comment",
    "page.archive",
    "page.collaborate",
    "issue.read",
    "issue.create",
    "issue.edit",
    "issue.transition",
    "issue.comment",
    "issue.archive",
    "todo.read",
    "todo.create",
    "todo.edit",
    "todo.archive",
    "calendar.read",
    "calendar.create",
    "calendar.edit",
    "calendar.archive",
    "schedule.execute",
    "realtime.read",
    "presence.write",
    "integration.read",
    "scale.read",
    "relationship.read",
    "relationship.edit",
    "graph.read",
    "canvas.read",
    "canvas.create",
    "canvas.edit",
    "canvas.comment",
    "canvas.present",
    "agent.read",
    "agent.invoke",
    "activity.read",
  ]),
  guest: new Set(["project.read", "agent.read"]),
};

export type CapabilityDecisionInput = {
  capability: ProjectCapability;
  workspaceActive: boolean;
  projectActive: boolean;
  membershipActive: boolean;
  roleCapabilities: ReadonlySet<ProjectCapability>;
  allowedGrants?: ReadonlySet<ProjectCapability>;
  deniedGrants?: ReadonlySet<ProjectCapability>;
  objectCapabilities?: ReadonlySet<ProjectCapability>;
  requiresObjectGrant?: boolean;
  providerAllows?: boolean;
  agentCapabilities?: ReadonlySet<ProjectCapability>;
  authorizingPrincipalCapabilities?: ReadonlySet<ProjectCapability>;
};

export type CapabilityDecision = {
  allowed: boolean;
  reason:
    | "allowed"
    | "workspace_inactive"
    | "project_inactive"
    | "membership_inactive"
    | "explicitly_denied"
    | "capability_missing"
    | "object_grant_missing"
    | "provider_denied"
    | "agent_grant_missing"
    | "authorizer_capability_missing";
};

export function evaluateProjectCapability(input: CapabilityDecisionInput): CapabilityDecision {
  if (!input.workspaceActive) return { allowed: false, reason: "workspace_inactive" };
  if (!input.projectActive) return { allowed: false, reason: "project_inactive" };
  if (!input.membershipActive) return { allowed: false, reason: "membership_inactive" };
  if (input.deniedGrants?.has(input.capability)) return { allowed: false, reason: "explicitly_denied" };

  const roleOrGrantAllows = input.roleCapabilities.has(input.capability)
    || Boolean(input.allowedGrants?.has(input.capability));
  if (!roleOrGrantAllows) return { allowed: false, reason: "capability_missing" };
  if (input.requiresObjectGrant && !input.objectCapabilities?.has(input.capability)) {
    return { allowed: false, reason: "object_grant_missing" };
  }
  if (input.providerAllows === false) return { allowed: false, reason: "provider_denied" };
  if (input.agentCapabilities && !input.agentCapabilities.has(input.capability)) {
    return { allowed: false, reason: "agent_grant_missing" };
  }
  if (input.authorizingPrincipalCapabilities
    && !input.authorizingPrincipalCapabilities.has(input.capability)) {
    return { allowed: false, reason: "authorizer_capability_missing" };
  }
  return { allowed: true, reason: "allowed" };
}

# Folio Product Definition

## Definition

Folio is a multi-tenant workspace where humans and AI agents collaborate on product work and its supporting knowledge. A workspace contains projects; each project connects issues, sub-issues, pages, GitHub repositories and branches, commits, pull requests, to-dos, and calendar entries through stable relationships and one permission system.

Folio is not a Git forge and does not replace GitHub. GitHub remains authoritative for Git-backed Markdown, refs, commits, repository permissions, and branch protection. Folio is authoritative for project organization, native pages, issues, to-dos, calendars, memberships, grants, agent state, confirmations, and audit history.

## Initial audience

The first cloud release is optimized for technical teams of 2–25 people that maintain documentation beside code and want project work, knowledge, and agent actions to share context. The product must still offer useful personal views, private to-dos, and a low-friction single-person workspace.

### Personas

- **Workspace owner:** establishes the workspace, identity policy, retention defaults, billing boundary, and administrators.
- **Project admin:** connects GitHub installations and repositories, configures branches and write policy, manages members and agents, and owns project workflows.
- **Contributor:** reads and edits permitted pages, manages issues and to-dos, and creates branches or pull requests within policy.
- **Guest collaborator:** reads, comments on, or narrowly edits explicitly granted project objects.
- **Agent authorizer:** invokes or schedules an agent and remains accountable for the authority delegated to that execution.
- **AI agent:** a named project principal with declared capabilities, bounded context, tools, revision preconditions, and an authorizing principal.
- **System worker:** processes trusted jobs under a narrowly scoped system capability and never inherits a user's ambient session.

## Jobs to be done

1. Understand a project without switching among an issue tracker, wiki, GitHub, calendar, and agent chat.
2. Edit repository documentation through an auditable Git workflow without losing Markdown validity or overwriting upstream work.
3. Plan and track work from roadmap to nested issue to personal follow-up while preserving relationships and history.
4. Let an agent perform the same validated operations as a person without granting shell, database, or implicit administrator access.
5. Find relevant knowledge and work across native and Git-backed content while retaining source and permission provenance.
6. In a future phase, explore and spatially organize the connected project graph for brainstorming, planning, discussion, and agent-assisted synthesis.

## Product outcomes and success measures

- A new team can create a workspace, create two projects, install the GitHub App, select a repository and branch, and read synchronized Markdown within 15 minutes.
- At least 99.9% of published synchronization snapshots exactly identify their repository, branch head, and reconciliation result; partial snapshots are never marked successful.
- A permitted Markdown edit can be prepared, reviewed as a diff, committed to a new branch, and opened as a pull request without leaving Folio.
- Every sampled mutation can be attributed to an actor and authorizing principal with its target, input summary, result, and timestamp.
- Authorization tests cover every role/capability cell and demonstrate cross-project and cross-workspace isolation.
- Human and agent stale writes fail with the same machine-readable conflict rather than overwriting a newer revision.
- Teams can link basic issues and sub-issues to pages in the first useful vertical slice.

## Assumptions and chosen defaults

- A user may belong to multiple workspaces; a project belongs to exactly one workspace.
- Projects are the primary content, collaboration, and authorization boundary.
- PostgreSQL is used locally and in production. SQLite is a legacy import source only.
- Managed OIDC provides identity, initially with GitHub sign-in and passwordless email recovery. GitHub App authorization is separate from sign-in.
- Git-backed pages are distinct per repository, branch, and path.
- Native pages use revisioned structured content and optimistic concurrency before real-time collaboration is introduced.
- Guests combine a restricted project membership with explicit object grants.
- Repository write policy is configurable as `disabled`, `pull_request_only`, or `direct_allowed`; the recommended default is pull-request-only.
- Project agents have declared grants, and every execution is further capped by its user or automation authorization.
- A future Canvas will use a structured scene graph over Folio's canonical typed relationships; Mermaid remains an embedded/interchange format rather than the Canvas substrate.

## Explicit non-goals for the first vertical slice

- Real-time native-page co-editing, external calendar synchronization, mobile-native applications, anonymous publishing, arbitrary Git forges, semantic/vector search, enterprise compliance certification, or self-hosted identity.
- Editing non-Markdown repository files, executing repository code or hooks, hosting Git repositories, or bypassing GitHub branch protections.
- Autonomous agents with unbounded project access, agent shell/database access, or permanent-delete agent tools.
- Full roadmap, cycle, recurrence, reminder, and native-page functionality in the first slice; their domain boundaries are designed now and implemented later.
- The spatial knowledge graph, graph explorer, and collaborative Canvas are a Phase 6 direction and are outside the current development cycle.

## Unresolved product decisions

The following remain explicit decisions rather than hidden assumptions:

- Billing unit, plan limits, and usage metering.
- Retention duration for archived content, raw webhook payloads, agent conversations, and audit exports.
- Whether direct push is ever permitted for R2 agent actions without per-action confirmation.
- The first supported external calendar provider and conflict semantics.
- Enterprise requirements for SCIM, SAML, data residency, legal hold, and customer-managed keys.
- When native pages require CRDT-based real-time collaboration and offline editing.
- Canvas rendering/collaboration technology, large-scene performance targets, and the first lossless Mermaid interchange subset.

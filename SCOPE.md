# Folio Scope and Requirements

## Functional requirements

### Identity, workspaces, and projects

- Authenticate humans through managed OIDC and maintain Folio-owned user, session, workspace, and membership records.
- Support multiple workspaces per user and multiple projects per workspace.
- Support project Admin, Member, and Guest role templates backed by capabilities, not scattered role checks.
- Invite, suspend, remove, and restore memberships with auditable lifecycle transitions.
- Keep workspace and project roles independently evolvable.

### GitHub integration and pages

- Connect repositories only through authorized GitHub App installations.
- Discover authorized repositories and branches; select multiple repositories and branches per project.
- Synchronize committed `.md` and `.markdown` blobs, receive webhooks, and periodically reconcile GitHub state.
- Render safe source and rich views with repository, branch, path, blob, commit, author, snapshot, and sync state.
- Create Markdown files, branches, commits, pushes, and optional pull requests under project write policy and GitHub authorization.
- Bind changes to base refs and blobs, display diffs, respect protection rules, and never silently overwrite conflicts.
- Keep Git-backed and native pages in one application-owned tree with unified search, links, backlinks, comments, mentions, relationships, and permissions.
- Make import, export, move, and conversion across page types explicit, previewed, and audited.

### Native knowledge

- Store structured native-page content, immutable revisions, comments, mentions, backlinks, attachments, and optimistic concurrency metadata.
- Support nested tree placement independent of Git paths.
- Add real-time collaborative editing later without changing page identity or revision APIs.

### Issues and project planning

- Support issues and nested sub-issues with configurable statuses, workflows, priorities, labels, human/agent assignees, estimates, and due dates.
- Support dependencies, typed relationships, comments, mentions, attachments, complete activity, and reversible transitions where possible.
- Support projects, milestones, cycles, roadmaps, lists, boards, timelines, calendars, filters, grouping, ordering, saved views, and search in phased releases.
- Link issues to pages, to-dos, branches, commits, and pull requests.

### To-dos and calendar

- Keep to-dos separate from issues while allowing typed links and promotion workflows.
- Support personal/private and project/shared lists, dates, reminders, recurrence, scheduling, human/agent assignees, and calendar views.
- Permit agent scheduling only within delegated scope and confirmation policy.
- Archive by default and restore without losing relationships or history.

### Agents

- Give important entities stable IDs, schemas, lifecycle operations, revision information, provenance, permissions, idempotent mutations, and machine-readable errors.
- Provide structured read/search and validated mutation tools without UI scraping.
- Apply the identical application-service authorization path to UI, API, worker, and agent calls.
- Return compact context containing IDs, revisions, effective permissions, provenance, warnings, and suggested next actions.
- Preview and confirm destructive, broad, privileged, or externally visible actions according to risk policy.

### Spatial knowledge and collaboration (future Phase 6)

- Provide a permission-filtered graph across pages, issues, to-dos, repositories, Git objects, humans, and agents.
- Distinguish explicit, derived, suggested, and canvas-only relationships with provenance and lifecycle.
- Provide a persistent infinite Canvas with entity cards, stickies, text, shapes, frames, connectors, drawings, comments, voting, and presentation regions.
- Keep canvas layout separate from entity content and domain authority; entity edits use ordinary application commands.
- Allow explicit promotion of visual connectors to typed domain relationships and previewed conversion of stickies into pages, issues, or to-dos.
- Give agents structured graph/scene tools and permission-filtered context instead of screenshot-based interaction.
- Support Mermaid diagrams and compatible import/export without using Mermaid as the Canvas storage or collaboration model.

## First useful vertical slice

The first release is bounded to:

1. Authentication, workspaces, multiple projects, and project memberships.
2. Admin, Member, and Guest authorization with capability checks and object grants.
3. GitHub App installation, repository selection, branch discovery, and branch switching.
4. Atomic synchronization, safe rendering, provenance, and search of GitHub Markdown.
5. Editing one Markdown file through a new branch, reviewed diff, commit, push, and pull request.
6. Basic issues and nested sub-issues linked to pages, with status, priority, assignee, and comments.
7. Agent tools for project/page reads, Markdown branch-and-PR editing, and issue management.
8. Audit logs, revision checks, idempotency, risk classification, and confirmation gates.

Native-page authoring, richer workflows, roadmaps, to-do recurrence, reminders, external calendars, the graph explorer, and Canvas are not required for this release.

## Non-functional requirements

- **Tenant isolation:** every tenant-owned row is workspace-scoped and every project-owned operation proves project membership or an explicit grant.
- **Availability:** target 99.9% monthly availability after public beta; degraded GitHub availability must not make the last good snapshot unreadable.
- **Consistency:** mutations are transactional within an aggregate; externally delivered events use an outbox; synchronization snapshot publication is atomic.
- **Concurrency:** mutable aggregates expose integer revisions and reject stale `If-Match` or `expected_revision` values.
- **Idempotency:** externally retryable mutations accept an idempotency key scoped to principal, operation, and project.
- **Performance:** p95 ordinary API reads under 300 ms and writes under 600 ms excluding external providers; first-page project search under 750 ms at initial scale.
- **Scale baseline:** 25 active members, 100 repositories, 50 selected branches, 100,000 pages/issues/to-dos, and 1 GB of indexed Markdown per workspace without redesign.
- **Accessibility:** WCAG 2.2 AA for primary workflows and full keyboard operation.
- **Observability:** correlated logs, metrics, traces, job attempts, webhook receipts, reconciliation summaries, and redacted errors.
- **Portability:** local Docker Compose and hosted containers use the same PostgreSQL schema and worker code.

## Security requirements

- Encrypt traffic in transit and secrets, GitHub credentials, and sensitive data at rest using managed KMS-backed keys.
- Store installation identifiers and encrypted token material only; mint short-lived GitHub installation tokens when needed.
- Verify webhook signatures before persistence or processing and deduplicate delivery IDs.
- Use secure, rotated sessions, CSRF protection, strict cookie settings, origin validation, rate limits, and reauthentication for sensitive account operations.
- Treat Markdown, comments, issue text, attachments, and repository metadata as untrusted. Sanitize rendering and never execute repository code, hooks, HTML, or instructions.
- Scan attachments, use signed object URLs, validate MIME/type/size, and isolate object keys by workspace.
- Redact secrets and full content bodies from logs, audit summaries, event payloads, and model context unless specifically required.
- Test OWASP ASVS-relevant controls, authorization denial paths, SSRF, path traversal, prompt injection, webhook replay, and dependency vulnerabilities.
- Archive ordinary content; permanent deletion requires impact preview, explicit warning, authorization, confirmation, and a documented audit-retention outcome.

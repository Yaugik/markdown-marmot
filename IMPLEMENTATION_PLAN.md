# Folio Phased Implementation Roadmap

Each phase is a deployable vertical slice with migrations, authorization tests, audit coverage, operational telemetry, and a documented rollback. Capability breadth does not advance until the preceding data-loss and authorization gates pass.

## Phase 0 — Cloud-capable foundation

Build the multi-tenant substrate before adding new product breadth:

- Replace runtime SQLite with PostgreSQL and introduce versioned migrations, UUIDv7 IDs, revisions, tenant/project scope, transactional outbox, activity, idempotency, and durable jobs.
- Add managed OIDC authentication, secure sessions, users/principals, workspaces, projects, memberships, role templates, capabilities, and object grants.
- Provide local Docker Compose for web, worker, PostgreSQL, and S3-compatible storage; define the container reference deployment, secrets/KMS boundary, backups, telemetry, and restore drill.
- Preserve the existing reader behind a legacy/local migration boundary until import is validated.

Acceptance:

- A clean checkout starts locally with no external dependency except the identity/GitHub development configuration.
- Cross-workspace/project denial, role-template, object-grant, revision, idempotency, outbox, job-lease, and append-only audit tests pass.
- PostgreSQL backup/restore and schema upgrade/downgrade strategy are exercised on representative data.

## Phase 1 — First useful collaboration slice

Deliver the promised end-to-end workflow:

- Workspace/project onboarding; Admin, Member, and Guest management.
- GitHub App installation callback, repository discovery/selection, multiple selected branches, Markdown scope, and configurable write policy.
- Verified webhooks, periodic/manual reconciliation, atomic published snapshots, safe rendering, provenance, branch switching, and PostgreSQL search.
- Source editing of one Markdown file, prepared diff, new branch, commit/push, pull request, and conflict handling.
- Basic workflows, issues/sub-issues, status, priority, human/agent assignee, comments, page links, revision history, archive/restore.
- Initial agent tools for projects, page search/read, Markdown preparation/commit/PR, issue management, confirmations, and audit.

Acceptance:

- Two members and one guest see exactly their authorized projects/objects across UI, API, search, events, and agent tools.
- A selected branch publishes a complete snapshot; webhook replay/reordering, truncated trees, failed candidates, force pushes, and token revocation converge without exposing partial success.
- A human and an agent can complete the branch-and-PR Markdown workflow; stale heads/blobs, branch protection, and changed policy stop safely.
- Issue/sub-issue operations reject stale revisions and invalid hierarchy while recording actor and authorizer.
- All first-slice API/tool schemas and authorization cells have contract tests.

## Phase 2 — Native knowledge collaboration

- Add structured native pages, immutable revisions, page tree, multi-placement/aliases, comments, mentions, attachments, links/backlinks, unified search, and page-level grants.
- Add supported rich Markdown editing with protected raw nodes and round-trip/diff gates.
- Add explicit Git-to-native import, native-to-Git export, conversion, and relationship reassignment previews.

Acceptance:

- Native and Git pages are visually and structurally distinguishable but searchable/linkable together.
- Source-specific mutation tools cannot cross page types.
- Round-trip fixtures cover the supported GFM subset, front matter, raw HTML, MDX, malformed content, Unicode, and protected-node preservation.
- Stale native edits and stale comment anchors are visible and recoverable.

## Phase 3 — Work management depth

- Add configurable workflows/statuses, labels, estimates, dependencies, milestones, cycles, roadmaps, saved views, filters/grouping/order, list/board/timeline/calendar projections, attachments, and richer relationships.
- Add bulk operations with impact previews and confirmation.

Acceptance:

- Workflow transitions, hierarchy and dependency cycles, archival/restoration, saved-view permission filtering, and bulk partial failures are tested.
- All issue changes are queryable through complete activity without storing sensitive full-body diffs in audit.

## Phase 4 — To-dos and scheduling

- Add private/personal and project/shared lists, nested to-dos, issue/page links, human/agent assignees, dates, recurrence, reminders, and calendar entries/views.
- Add permission-controlled agent scheduling and rescheduling.

Acceptance:

- Project administrators cannot read private to-do bodies by ambient role.
- Time-zone, DST, recurrence idempotency, reminder retry, sharing, assignment, archive/restore, and calendar permission-union tests pass.

## Phase 5 — Scale and ecosystem

- Add real-time native-page collaboration and presence after revision semantics are stable.
- Evaluate dedicated search and managed queue extraction from measured load.
- Add selected external calendars, enterprise identity/admin controls, data residency, audit exports, and provider extensions only through explicit decisions.

Acceptance depends on product-specific SLOs and the open decisions recorded in `DECISIONS.md`; no speculative infrastructure is a prerequisite for earlier phases.

## Phase 6 — Spatial knowledge and collaborative Canvas

- Add the canonical typed relationship service with explicit, derived, suggested, and canvas-only provenance.
- Deliver a permission-filtered Obsidian-like graph explorer with traversal, clustering, filters, and saved graph views.
- Add a persistent Miro-like Canvas with entity-backed cards, stickies, text, shapes, frames, connectors, drawings, comments, voting, and presentation regions without copying third-party branding or design.
- Allow Canvas to edit authoritative relationships and entities only through explicit typed commands, revisions, capability checks, audit, and confirmation.
- Add structured agent graph/Canvas tools, region-bounded context, organization, conversion, and synthesis workflows.
- Support Mermaid as an embedded diagram and compatible interchange format, not as the scene-graph or collaboration substrate.

Acceptance:

- Canvas access never leaks unauthorized entity titles, types, edges, previews, private to-dos, or hidden counts.
- Layout changes do not mutate entity content; promoted connectors and sticky conversions produce ordinary domain activity/outbox records.
- Graph provenance, derived-edge rebuilding, large-scene performance, scene conflict/convergence, keyboard/non-spatial accessibility, export safety, and agent authorization tests pass.
- Phase 6 begins only after the prior core domains are stable; no Canvas runtime infrastructure is required in the current development cycle.

## Cross-phase release gates

- Threat model and authorization matrix updated with each capability.
- No unresolved high-severity data-loss, tenant-isolation, credential, or silent-conflict defect.
- Migrations are forward tested; destructive migrations require backup/restore and compatibility windows.
- Accessibility, dependency audit, typecheck, lint, unit/integration/contract tests, and critical browser workflows pass.
- Metrics and redacted errors make provider, job, synchronization, and confirmation failures actionable.

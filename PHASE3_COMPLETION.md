# Phase 3 Completion Record

Updated: 2026-07-16

## Status

The Phase 3 work-management implementation is complete on `agent/phase-3-work-management` as a stacked review candidate based on the completed Phase 2 page workspace.

The branch remains a draft-review candidate until the complete repository can be checked out on a developer machine and the full migration, lint, typecheck, test, and production-build commands are run without GitHub Actions.

## Delivered

### Configurable workflows and statuses

- Project-scoped workflow definitions with stable IDs and revisions.
- Exactly one initial status per workflow.
- Backlog, planned, in-progress, completed, and canceled status categories.
- Explicit allowed status-transition graphs.
- Optional transition-comment requirements for individual and bulk transitions.
- Revision-checked status metadata and ordering updates.
- Idempotent default workflow creation for projects creating their first issue.
- PostgreSQL enforcement that transition endpoints belong to the selected workflow.

### Authoritative issue lifecycle

- Stable project issue numbers and identifiers such as `WORK-42`.
- Structured issue descriptions with bounded validation and plain-text projection.
- Priority, estimates, rank, start and due dates.
- Parent/sub-issue hierarchy with database cycle rejection.
- Explicit workflow transitions with optimistic concurrency.
- Assignees and labels restricted to active project members and labels.
- Archive and restore without deleting issue history.
- Parent archive protection while active child issues remain.
- Parent-first restore behavior in the service and a deferred PostgreSQL active-parent invariant.
- Object-grant-aware issue authorization.

### Relationships and collaboration

- Structured issue comments with redacted activity summaries.
- Blocking, related, and duplicate relationships.
- Blocking dependency-cycle rejection in PostgreSQL.
- Revision-checked relationship creation and removal.
- Links to issues, pages, and bounded HTTP(S) resources.
- Reversible issue-link lifecycle.
- Page authorization reused for issue-to-page links.
- Permission-filtered relationship reads that omit unreadable issue/page targets.
- Relationship deletion bound to the issue ID in the route before mutation.
- General issue envelopes omit relationship targets and hidden relationship counts.

### Attachments

- Bounded 10 MiB issue and issue-comment attachment preparation.
- Exact size and SHA-256 verification.
- Authenticated private upload and download.
- Safe content disposition and no-store delivery.
- Development object storage under `.local-data/issue-attachments`.

### Portfolio planning

- Project labels with color metadata.
- Milestones with target dates and lifecycle state.
- Cycles with bounded start/end dates and state.
- Project/private roadmaps.
- Revision-checked roadmap placement with optional issue start/end overrides.
- Active milestone and cycle enforcement for new and bulk issue references.
- Reversible dependency history through active-only uniqueness.

### Saved views and projections

- Private and project-visible saved views.
- Object-grant sharing and discovery for private views.
- Project-visible view discovery restricted to project-wide issue readers.
- Publishing or editing a project-visible view requires `project.update`.
- Filters for status, label, assignee, priority, milestone, cycle, parent, archived state, and search query.
- Deterministic multi-field ordering.
- Grouping by status, priority, assignee, label, milestone, or cycle.
- List, board, timeline, and calendar projections over the same permission-filtered issue query.
- A shared private view never broadens the recipient's issue access.

### Bulk safety

- Bulk patch, transition, archive, and restore previews.
- Target revision/status/workflow/lifecycle/parent snapshots.
- Accessible, unavailable, and blocked impact counts.
- Fifteen-minute preview expiry with explicit expired-state errors.
- Creator-scoped PostgreSQL row-level security for previews.
- R2 confirmation for more than ten accessible issues.
- Confirmation bound to the exact action digest and authorizing principal.
- Single-use confirmation consumption.
- Per-issue authorization and revision revalidation at execution.
- Child-first archive and parent-first restore ordering.
- Per-target savepoints so validation and database-invariant failures become partial results rather than aborting the batch.
- Partial results with explicit succeeded and failed targets.
- Individual redacted activity and outbox records for every successful issue mutation.

### Browser workspace

- `/issues` project workspace integrated into the existing Folio sidebar.
- Issue creation and searchable project projections.
- List, board, timeline, and calendar modes.
- Private saved-view creation and reuse.
- Issue selection, workflow transitions, comments, dates, priority, and attachments.
- Multi-select bulk archive preview and confirmation flow.
- Responsive desktop and narrow-screen layouts.

## API additions

### Issues

- `GET /api/v1/issues`
- `POST /api/v1/issues`
- `GET /api/v1/issues/{issueId}`
- `PATCH /api/v1/issues/{issueId}`
- `POST /api/v1/issues/{issueId}/transition`
- `POST /api/v1/issues/{issueId}/archive`
- `POST /api/v1/issues/{issueId}/restore`

### Collaboration and relationships

- `GET|POST /api/v1/issues/{issueId}/comments`
- `GET|POST /api/v1/issues/{issueId}/dependencies`
- `DELETE /api/v1/issues/{issueId}/dependencies/{dependencyId}`
- `GET|POST /api/v1/issues/{issueId}/links`
- `DELETE /api/v1/issues/{issueId}/links/{linkId}`
- `GET|POST /api/v1/issues/{issueId}/attachments`
- `GET|PUT /api/v1/issue-attachments/{attachmentId}/content`

### Configuration and planning

- `GET|POST /api/v1/issue-workflows`
- `PATCH /api/v1/issue-workflows/statuses/{statusId}`
- `GET|POST /api/v1/issue-portfolio`
- `POST /api/v1/issue-portfolio/{kind}/{id}/archive`
- `POST /api/v1/roadmaps/{roadmapId}/items`

### Views and bulk operations

- `GET|POST /api/v1/issue-views`
- `PATCH /api/v1/issue-views/{viewId}`
- `POST /api/v1/issue-projections`
- `POST /api/v1/issue-bulk`
- `GET /api/v1/issue-bulk/{previewId}`
- `POST /api/v1/issue-bulk/{previewId}/execute`
- `POST /api/v1/issue-bulk/confirmations/{confirmationId}/approve`

## Acceptance coverage

`src/services/phase3.integration.test.ts` provisions an isolated tenant and covers:

- a custom workflow and allowed transition;
- rejection of a disallowed transition;
- hierarchy-cycle rejection;
- blocking dependency-cycle rejection;
- child-aware archive and restore behavior;
- comments and roadmap placement;
- private and project saved-view filtering;
- object-grant access to a private saved view;
- board projection execution for a read-only reviewer;
- stale-target bulk partial failure with one success and one `REVISION_CONFLICT`;
- issue attachment integrity and authenticated reads;
- activity summaries that exclude sensitive full description content.

`src/services/phase3-security.integration.test.ts` adds focused coverage for:

- hidden dependency and issue-link targets not being returned to an object-only reader;
- creator-owned bulk previews not being readable by another project member;
- a non-admin saved-view owner being unable to publish a private view;
- child restoration being rejected until its parent is active;
- a mixed bulk patch returning one success and one validation failure without rolling back the success.

`src/services/phase3-saved-view-policy.integration.test.ts` verifies that an object-granted private view is discoverable while its projection remains empty when the recipient has no issue grants.

Migration assertions cover deterministic ordering through `0012_phase3_security_hardening.sql` and verify the workflow, hierarchy, dependency, search, portfolio, active-parent, and creator-scoped preview invariants.

## Verification boundary

No GitHub Actions workflow is included, following the requested testing preference.

This environment cannot materialize the complete GitHub branch into a local checkout because direct GitHub archive and clone access is unavailable. The implementation received connector-level file, schema, import-path, authorization, transaction, and branch-diff review. The acceptance tests above are committed but have not been executed in this environment.

Full executable verification remains:

1. `npm install`
2. `npm run db:migrate:folio`
3. `npm run lint`
4. `npm run typecheck`
5. `npm run test`
6. `npm run build`

The repository's existing stale lockfile still prevents deterministic `npm ci` until its missing transitive records are regenerated and committed.

## Out of Phase 3

- To-dos, reminders, recurrence, and the mixed calendar are Phase 4.
- Realtime collaboration, scale extraction, enterprise integrations, graph, and Canvas remain later phases.
- Production S3-compatible attachment storage and GitHub provider execution remain their existing Phase 0/1 deployment boundaries.

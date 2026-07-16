# API and Event Boundaries

## API principles

Folio exposes versioned REST/JSON under `/api/v1`. UI actions, public API clients, agent tools, and workers call the same application commands and queries; adapters do not contain independent authorization or business rules.

Resources use stable UUIDv7 IDs and integer revisions. Clients send `If-Match: "<revision>"` for HTTP updates or `expected_revision` through structured tools. Retryable mutations require `Idempotency-Key`. Every request accepts/returns a `request_id` and emits a trace ID.

## Resource boundaries

- `/workspaces`, `/workspace-memberships`, `/projects`, `/project-memberships`, `/grants`
- `/github/installations`, `/projects/{id}/repositories`, `/selected-branches`, `/sync-requests`, `/sync-snapshots`
- `/pages`, `/page-tree`, `/native-page-revisions`, `/prepared-git-changes`, `/git-operations`
- `/issues`, `/workflows`, `/milestones`, `/cycles`, `/roadmaps`, `/saved-views`
- `/todo-lists`, `/todos`, `/calendar`, `/reminders`
- `/agents`, `/agent-sessions`, `/tool-calls`, `/confirmations`
- `/activity`, `/audit-exports`, `/operations`
- Future Phase 6: `/relationships`, `/graph`, `/graph-views`, `/canvases`, `/canvas-elements`, `/canvas-connectors`, and `/canvas-collaboration`

Commands with distinct lifecycle or risk semantics use explicit endpoints such as `issues/{id}:transition`, `pages/{id}:archive`, `prepared-git-changes/{id}:commit`, and `confirmations/{id}:approve` rather than generic state patches.

## Query and mutation envelopes

```json
{
  "data": {},
  "meta": {
    "request_id": "uuidv7",
    "trace_id": "opaque",
    "next_cursor": null
  }
}
```

Mutation data includes the resource ID/revision, activity ID, operation ID for asynchronous effects, warnings, effective permissions, provenance, and suggested next actions where meaningful.

List endpoints use opaque cursor pagination with stable order and bounded limits. Search cursors include the query/index generation and reject incompatible reuse.

## Error envelope

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "The issue changed after it was read.",
    "details": {"expected_revision": 12, "current_revision": 13},
    "retryable": false,
    "field_errors": [],
    "suggested_actions": ["read_issue", "reapply_patch"]
  },
  "meta": {"request_id": "uuidv7", "trace_id": "opaque"}
}
```

Stable families include `UNAUTHENTICATED`, `CAPABILITY_DENIED`, `OBJECT_NOT_GRANTED`, `VALIDATION_FAILED`, `NOT_FOUND`, `REVISION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `CONFIRMATION_REQUIRED`, `CONFIRMATION_EXPIRED`, Git conflict codes, `PROVIDER_RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, and `OPERATION_FAILED`.

## Asynchronous operations

Long-running commands return `202 Accepted` with an operation ID. Operation states are `queued`, `running`, `waiting_provider`, `blocked_confirmation`, `succeeded`, `succeeded_with_warnings`, `failed`, or `canceled`. Success requires an observed domain/provider result, not merely job dispatch.

Jobs contain a versioned internal command, workspace/project scope, principal chain, risk/confirmation reference, idempotency/deduplication keys, and redacted payload. Workers revalidate current authorization and external preconditions before effects.

## Transactional events

Every authoritative mutation writes its aggregate and an outbox event in one transaction. The standard event envelope is:

```json
{
  "event_id": "uuidv7",
  "event_type": "issue.transitioned",
  "schema_version": 1,
  "occurred_at": "2026-07-13T10:00:00Z",
  "workspace_id": "uuidv7",
  "project_id": "uuidv7",
  "aggregate": {"type": "issue", "id": "uuidv7", "revision": 8},
  "actor": {"principal_id": "uuidv7", "authorizing_principal_id": "uuidv7"},
  "request_id": "uuidv7",
  "trace_id": "opaque",
  "payload": {}
}
```

Payloads are minimal and redacted; consumers fetch authorized details when needed. Event schemas are additive within a version. Breaking changes use a new version and a migration window.

## Event categories

- **Domain events:** committed facts such as `page.revised`, `issue.transitioned`, `todo.archived`, and `grant.revoked`.
- **Integration commands:** requested effects such as `github.reconcile_requested`, `github.commit_requested`, or `notification.send_requested`; these are not facts of completion.
- **Integration observations:** `github.snapshot_published`, `github.pull_request_opened`, or provider failure facts after verification.
- **Webhook receipts:** immutable verified provider deliveries retained separately from domain events.
- **Job events:** operational attempts and state, never substituted for activity or audit.
- **Audit/activity:** human-readable, append-only mutation attribution created from the command transaction, not reconstructed solely from asynchronous events.
- **Spatial collaboration:** durable events such as `relationship.created`, `canvas.revised`, `canvas.connector_promoted`, and `canvas.sticky_converted`; cursors, selections, and transient presence are not outbox/audit events.

## Initial public operations

The first slice publishes workspace/project membership, repository/branch selection, page/search/read, sync status/request, prepared Markdown change/commit/PR, basic issue/sub-issue, activity, agent tool, confirmation, and operation-status APIs. Native pages, advanced planning, and to-do/calendar APIs may be specified but remain disabled until their roadmap phase.

Graph and Canvas APIs remain disabled until Phase 6. They use the same stable entity IDs, revisions, idempotency, capability checks, activity, outbox, and agent contracts; Canvas access never expands referenced-entity permissions.

## Compatibility and security

- OpenAPI and JSON Schema are generated and checked in for released endpoints and agent tools.
- Unknown fields are rejected on mutation inputs unless a schema explicitly permits extension metadata.
- Authorization occurs before existence-sensitive error detail to avoid cross-tenant enumeration.
- ETags and idempotency semantics are covered by contract tests across UI, API, and agent adapters.
- Webhooks use provider-specific authenticated endpoints and never share public API session authentication.

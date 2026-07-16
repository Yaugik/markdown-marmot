# Agent Tools and Safety

## Operating model

An agent is a named project principal, not an ambient chatbot. It has explicit grants, model/context policy, enabled state, and audit identity. Interactive executions are authorized by both the agent and initiating human. Automations use narrow, expiring automation grants. Agents have no shell, SQL, arbitrary filesystem, credential, or unrestricted network access.

Repository content, pages, issues, comments, tool results, and attachments are untrusted data. Instructions contained in them never alter system policy, authorization, confirmation rules, tool schemas, or the user's request.

## Common request contract

Every mutation accepts:

```json
{
  "request_id": "uuidv7",
  "idempotency_key": "client-generated-key",
  "project_id": "uuidv7",
  "expected_revision": 17,
  "input": {}
}
```

Read tools require a request ID and scope but not idempotency. Entity inputs use Folio IDs; repository paths are accepted only by Git-specific tools after repository/branch scope is established.

Successful responses include `data`, `permissions`, `revision` or source revision, `provenance`, `warnings`, `activity_id` for mutations, and `suggested_next_actions`. Errors use the API error envelope and never claim an effect without an observed result.

## Risk classification

| Level | Meaning | Default handling | Examples |
|---|---|---|---|
| R0 | Read-only | No confirmation | list/search/read/status/diff |
| R1 | Scoped, internal, reversible | Execute when explicitly requested and unambiguous | create issue, edit native page, comment, archive one item |
| R2 | Consequential, broad, scheduled, or externally visible | Preview/confirmation when agent policy requires; always show exact effect | commit/push, open PR, invite, bulk update, recurring schedule |
| R3 | Destructive, privileged, policy-changing, or high blast radius | Fresh explicit confirmation bound to digest; often unavailable to agents | role/policy changes, purge, direct protected-path push, broad archive |

More than 10 affected entities is broad by default. Project policy may lower but not raise mandatory safety thresholds. Ambiguous entity matches, changed inputs, expired approvals, or material provider-state changes require a new preview.

## Initial tool catalog

### R0 reads

- `list_projects`: permitted projects with IDs, role/capability summary, revision, and archival state.
- `search_workspace`: permission-filtered cross-source results with entity type, ID, snippets, provenance, revision, and cursor.
- `read_page`: native or Git-backed page content bounded by size/section, source descriptor, revision, links, and sync/conflict state.
- `list_page_tree`: permitted tree nodes and source types.
- `read_issue`, `search_issues`: issue fields, hierarchy, relationships, workflow transitions, and recent activity.
- `list_calendar`: permitted date range of to-dos, issues, milestones, cycles, and entries without broadening source access.
- `get_sync_status`: selected branch, active snapshot/head, candidate/job state, warnings, and staleness.
- `get_diff`: prepared Git/native change digest and exact bounded diff.

### R1 reversible/internal mutations

- `create_native_page`, `edit_native_page`, `archive_page`, `restore_page`.
- `create_issue`, `create_sub_issue`, `update_issue`, `transition_issue`, `assign_issue`, `comment_on_issue`, `archive_issue`, `restore_issue`.
- `create_todo`, `update_todo`, `schedule_todo`, `archive_todo`, `restore_todo`.
- `create_branch` when it does not expose content or violate project confirmation policy.
- `create_markdown_file` and `edit_markdown_file` create a local prepared change only; they do not imply a GitHub write.
- `prepare_commit` validates and freezes a diff digest without changing GitHub.

### R2 externally visible or broad mutations

- `commit_changes`: create Git objects and update the approved target ref from an unexpired preparation.
- `open_pull_request`: create a PR from an observed committed branch.
- bulk issue/page/to-do changes, invitations, sharing, reminders, and recurrence scheduling.
- import/export/conversion between native and Git-backed pages.

### R3 privileged/destructive operations

Repository policy changes, agent grant changes, mass archival, repository disconnect/purge, and permanent deletion are separate administrative workflows. Permanent deletion is not an initial agent tool.

## Future graph and Canvas tools (Phase 6)

Agents will receive a structured, permission-filtered graph and scene region rather than screenshots. Planned R0 tools include `search_graph`, `expand_graph`, `read_graph_neighbors`, `read_canvas`, and `read_canvas_region`. Planned R1 tools include `create_canvas`, `add_entity_to_canvas`, `create_sticky`, `create_shape`, `create_frame`, `connect_canvas_nodes`, `move_canvas_elements`, and `organize_canvas_region`.

`promote_connector_to_relationship`, sticky-to-entity conversions, bulk graph changes, Canvas export/sharing, and workshop-output creation inherit the target domain's R1–R3 risk and confirmation requirements. Layout-only changes never imply entity or relationship mutation. Tool context includes stable IDs, scene/canvas revision, element revisions, geometry, provenance, permissions, and selected/visible region bounds.

## Representative schemas

### `edit_markdown_file`

```json
{
  "project_id": "uuidv7",
  "page_id": "uuidv7",
  "base_snapshot_id": "uuidv7",
  "base_commit_oid": "sha",
  "base_blob_oid": "sha",
  "mode": "source|rich",
  "markdown": "complete proposed markdown",
  "expected_revision": 9,
  "idempotency_key": "key"
}
```

Returns a prepared file change with normalized source, render validation, base/proposed hashes, warnings, and diff digest. It cannot push.

### `commit_changes`

```json
{
  "project_id": "uuidv7",
  "prepared_change_id": "uuidv7",
  "prepared_revision": 2,
  "action_digest": "sha256",
  "confirmation_id": "uuidv7-or-null",
  "commit_message": "docs: clarify setup",
  "idempotency_key": "key"
}
```

Returns operation state and eventual branch/commit provenance. Changed base refs or blobs return conflicts and consume no Git write confirmation.

### `update_issue`

```json
{
  "project_id": "uuidv7",
  "issue_id": "uuidv7",
  "expected_revision": 14,
  "patch": {"priority": "high", "due_on": "2026-07-20"},
  "idempotency_key": "key"
}
```

Lifecycle actions such as transition, archive, or restore use dedicated tools rather than hidden field patches.

## Confirmation protocol

1. Normalize and authorize the requested operation.
2. Calculate risk, exact targets/count, before/after summary, external effects, reversibility, warnings, and expiry.
3. Hash the canonical operation name, actor chain, scope, target revisions/provider bases, and normalized inputs.
4. Persist a pending single-use confirmation and return the preview.
5. Approval records the deciding human; execution accepts only the same digest before expiry.
6. Re-authorize and revalidate revisions/provider state. Material changes invalidate the confirmation.
7. Atomically mark the confirmation consumed with the accepted command or record a non-mutating failure.

## Context and privacy

- Context is retrieved through permission-filtered reads, minimized to the current task, and labeled with source IDs and trust boundaries.
- Secrets, installation tokens, hidden objects, unrelated pages, private to-dos, and full audit payloads are never model context.
- Provider/model identity and data-use policy are visible to the user. Context and session retention follow workspace policy.
- Tool outputs cap content size and paginate. Agents must request additional sections rather than receive entire repositories.

## Agent acceptance tests

- An agent cannot exceed either its own grants or its authorizing principal.
- Access revocation blocks queued consequential work on re-authorization.
- Prompt instructions inside Markdown cannot invoke a tool or alter confirmation policy.
- Idempotent retries return the original observed result; a changed payload with the same key fails.
- Stale revisions, ambiguous matches, expired confirmation, and changed Git heads return machine-readable errors.
- Partial bulk/provider failures identify each target and never report aggregate success incorrectly.
- Every mutation produces actor, authorizer, action, target, input/result summary, request, confirmation where applicable, and timestamp.

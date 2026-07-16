# Folio Personas and Critical Workflows

## Critical user stories

- As a workspace owner, I can create isolated projects and delegate project administration without granting workspace administration.
- As a project admin, I can connect only GitHub repositories approved for the selected App installation and configure branch and write policy.
- As a member, I can search and navigate native and Git-backed pages together while always seeing their source and mutation behavior.
- As a contributor, I can edit Markdown through a branch and pull request with a diff and conflict check before GitHub changes.
- As a project lead, I can manage nested issues and connect them to the pages, branches, commits, and pull requests that explain the work.
- As an individual, I can maintain private to-dos alongside shared project to-dos and calendar entries.
- As a guest, I can access only the project baseline and objects explicitly granted to me.
- As an agent authorizer, I can understand and approve the exact effects of a risky action and later audit its result.
- As an agent, I can obtain compact structured context and invoke typed operations without scraping UI state.

## Workflow 1: create a workspace and project

1. A user authenticates through managed OIDC; Folio creates or resolves the human principal.
2. The user creates a workspace and becomes its Owner through an auditable membership event.
3. The owner creates a project with a key, time zone, default workflow, and default Git write policy.
4. The owner invites Admin, Member, or Guest memberships. Accepted invitations create project principals and grants.
5. All subsequent reads and mutations resolve effective capabilities from workspace status, project membership, object grants, and target policy.

Success: a member of project A cannot enumerate or access project B without an independent grant.

## Workflow 2: install GitHub and publish an atomic snapshot

1. A project admin starts the GitHub App installation flow and chooses an installation authorized by GitHub.
2. Folio lists only repositories visible to that installation. The admin selects repositories, branches, Markdown scopes, and write policy.
3. Folio creates a reconciliation request and resolves the exact branch head.
4. The worker inventories eligible blobs, parses and validates them into an immutable candidate snapshot, and records per-file outcomes.
5. Only a complete reconciliation transaction activates the candidate snapshot. A failure leaves the last good snapshot active and visibly stale.
6. Webhooks enqueue targeted reconciliation; periodic jobs independently converge selected branches with GitHub state.

Success: every visible Git-backed page belongs to one published snapshot with an exact repository, branch, head commit, path, and blob.

## Workflow 3: edit Markdown through a pull request

1. A user or agent reads a Git-backed page and receives content, base blob, base branch head, revision, permissions, and write policy.
2. The editor uses lossless source mode or supported rich mode. Folio parses the result, verifies round-trip safety, and produces a source diff.
3. `prepare_commit` validates Markdown-only scope, branch name, base identifiers, GitHub permissions, and project policy without changing GitHub.
4. After any required confirmation, Folio rechecks the base ref and blobs, creates a branch, writes blobs/tree/commit, and updates the new ref.
5. Folio opens a pull request when requested and records GitHub identifiers and URLs.
6. A webhook/reconciliation later publishes the resulting branch snapshot. No optimistic UI state is represented as synchronized content.

Conflict: if the base ref or blob changed, the operation returns `BASE_REF_CHANGED` or `BLOB_CHANGED` with merge inputs; it never overwrites.

## Workflow 4: manage issues and sub-issues

1. A member creates an issue in a project workflow with title, status, priority, and optional assignee or page link.
2. Sub-issues reference a parent in the same project; hierarchy and dependency cycles are rejected.
3. Updates include an expected revision and append field-level activity summaries.
4. Status transitions are validated by the configured workflow and actor capabilities.
5. Comments, mentions, page links, branch/commit/PR links, and assignee changes retain attribution.
6. Archival removes the issue from normal views without deleting children, comments, or history; restoration is explicit.

## Workflow 5: coexistence of native and Git-backed pages

1. A project tree node references either a native page or one branch-scoped Git-backed page.
2. Moving or duplicating the tree node changes Folio metadata only and never moves a Git file.
3. Links resolve by stable Folio page ID and display source provenance. Backlinks are indexed across both types.
4. Editing a native page creates a Folio revision; editing a Git-backed page starts the Git workflow.
5. Import, export, or conversion displays the new authority, destination, links affected, and resulting audit event before mutation.

## Workflow 6: personal and shared scheduling

1. A user creates a private to-do or a project to-do with optional issue/page links.
2. Sharing, assignment, reminders, recurrence, and rescheduling are capability-checked independently from issue permissions.
3. Calendar queries combine permitted dated issues, to-dos, milestones, cycles, and calendar entries without weakening their source permissions.
4. Completion and archival remain separate lifecycle actions; recurring occurrence generation is idempotent.

## Workflow 7: authorize and audit an agent action

1. The user invokes a named project agent or an approved automation grant invokes it within its schedule.
2. Folio computes the intersection of agent grants, authorizing-principal capabilities, target policy, and GitHub authorization.
3. The agent receives bounded schemas and context, calls read tools to resolve stable IDs, then submits a typed mutation with revision and idempotency data.
4. R0 and eligible R1 actions execute; policy-selected R2 or any R3 action returns a preview and single-use action digest.
5. Approval executes only the unchanged normalized action before expiry.
6. The response reports exact successes, conflicts, warnings, partial failures, activity IDs, and suggested next actions.

## Future workflow 8: explore a graph and collaborate on Canvas (Phase 6)

1. A user opens a permission-filtered graph around a page, issue, to-do, repository, person, or agent and expands typed relationships with provenance.
2. The user saves a graph view or places selected entities onto a collaborative Canvas alongside stickies, shapes, frames, drawings, and visual connectors.
3. Moving and styling cards changes Canvas presentation only. Opening or editing a card uses the referenced entity's current permission and revision.
4. A visual connector remains canvas-only unless a user or agent explicitly promotes it to a typed domain relationship.
5. A sticky can be converted through a previewed command into a native page, issue, or to-do while retaining origin provenance.
6. Agents read the selected/visible scene region as structured elements and may organize, summarize, or prepare conversions within their grants and confirmation policy.
7. Unauthorized referenced entities are omitted or redacted without leaking titles, types, previews, connections, private to-dos, or hidden counts.

This workflow is a strategic Phase 6 direction and is not part of the current development cycle.

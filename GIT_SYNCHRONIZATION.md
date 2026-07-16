# GitHub App Integration and Synchronization

## Authority and permissions

GitHub is authoritative for repositories, refs, commits, blobs, pull requests, repository authorization, and branch protection. Folio connects through a GitHub App, never by collecting a user's personal access token.

Minimum App permissions are requested by feature: repository metadata read, contents read for synchronization, contents write for enabled Markdown write-back, and pull requests write when PR creation is enabled. Installation selection and repository access are controlled by GitHub. Folio rechecks the installation and its repository permissions before consequential operations.

Installation tokens are short-lived and minted just in time. Folio stores installation IDs and an encrypted credential/key reference, not reusable plaintext tokens. Revocation, suspension, repository removal, permission changes, and rate-limit state are modeled explicitly.

## Repository and branch selection

- A project may connect multiple repositories through one or more installations.
- An authorized repository may be linked to multiple projects, but each link has independent selected branches, Markdown scopes, tree placement, and write policy.
- Each selected branch has independent published snapshots and page identities.
- Inclusion/exclusion rules accept normalized repository-relative POSIX paths and permit only `.md` and `.markdown` files initially.
- Rules and write policies are previewed before activation. A write path must match the writable Markdown scope even if it is readable.

## Webhooks and reconciliation

Webhook endpoints verify the raw-body HMAC signature, validate the App/installation, persist the unique GitHub delivery ID, and acknowledge quickly. Processing is asynchronous. Push, repository, installation, installation-repositories, pull-request, and relevant protection events enqueue targeted work.

Webhooks are signals rather than complete history. Delivery can be duplicated, delayed, reordered, or omitted. Periodic reconciliation scans every enabled selected branch, with frequency based on recent activity and provider limits. Manual reconciliation uses the same algorithm.

## Atomic synchronization algorithm

1. Authorize the request, deduplicate it for the selected branch/head hint, and claim a branch-scoped lease.
2. Resolve the installation, repository, selected branch, and exact current head commit through GitHub.
3. Create an invisible candidate snapshot bound to that head and the current rule/parser/index versions.
4. Enumerate the Git tree. If GitHub's recursive response is truncated, traverse subtrees with bounded pagination rather than accepting an incomplete inventory.
5. Filter eligible Markdown paths deterministically. Compare with the previous published inventory to classify add, change, rename evidence, removal, scope entry/exit, unchanged, and re-index.
6. Fetch eligible blobs with per-file and per-snapshot size limits. Verify object IDs, decode supported UTF-8, parse Markdown, sanitize rendering, extract headings/links/text, and stage file results.
7. Treat policy-defined file warnings as snapshot warnings. A missing inventory segment, head inconsistency, provider ambiguity, or fatal parse/index infrastructure failure makes the candidate unpublishable.
8. Re-resolve the branch head. If it changed during reconciliation, discard or supersede the candidate and enqueue the new head.
9. In one transaction, mark the candidate published, switch the selected branch's active snapshot, update Git-page availability/provenance, append summary activity, and enqueue search/index events.
10. Release the lease and expose exact counts, warnings, failures, head, and retry guidance.

The prior snapshot remains readable and visibly stale whenever a candidate fails. No per-file update becomes the successful branch view before publication.

## Page identity and change classification

A Git page is branch-scoped by project repository link, selected branch, and path. Confident same-branch rename evidence may retain the Folio page ID and update its source path only when the snapshot algorithm can prove a one-to-one mapping. Ambiguous delete/add remains two identities; the UI may offer an audited manual relationship or tree-node reassignment.

The same path on two branches is two pages. Cross-branch comparison is an explicit operation and never changes page identity.

## Markdown write workflow

Repository links configure:

- `disabled`: Git-backed pages are read-only.
- `pull_request_only`: changes must target a new/existing non-protected working branch and normally open a PR.
- `direct_allowed`: direct ref updates are possible only for permitted branches/paths and when GitHub permits them.

The recommended template and first guided flow are branch plus pull request.

### Prepare

`prepare_commit` receives repository/selected branch IDs, base head, file operations with base blob IDs, target-branch intent, commit message, and expected Folio revisions. It validates capability, agent delegation, write policy, Markdown-only paths, size, Markdown validity, target naming, and provider metadata. It returns a normalized diff, risk, warnings, digest, expiry, and required confirmation without changing GitHub.

### Execute

Immediately before effect, the worker re-authorizes and re-resolves the base ref and every base blob. It then uses GitHub Git object APIs to create blobs, a tree, a commit, and a ref or conditional ref update. Pull-request creation is a distinct recorded operation and may be retried idempotently using stored provider identifiers.

Git commits retain the human/agent display attribution in Folio and use the configured GitHub App commit identity, with trailers or structured metadata linking the Folio actor, authorizing principal, operation, and audit ID without exposing private data.

## Conflicts

- `BASE_REF_CHANGED`: the base branch no longer equals the prepared head.
- `BLOB_CHANGED`: an edited/deleted path no longer has the prepared blob.
- `TARGET_REF_CHANGED`: an existing target branch moved after preparation.
- `PATH_POLICY_CHANGED`: Folio path/write policy changed.
- `GITHUB_PERMISSION_CHANGED`: installation or repository permission no longer permits the action.
- `BRANCH_PROTECTED`: GitHub refuses the intended update.

Folio never silently chooses remote or local content. It returns base, current remote, and proposed identifiers plus a suggested rebase/merge workflow. A new preparation and diff are required after resolution.

## Reliability, limits, and observability

- Provider writes are serialized per target ref and use idempotency records plus observed GitHub IDs.
- Rate-limit headers and secondary limits schedule retries; user-visible jobs distinguish waiting, retrying, blocked, failed, and succeeded.
- Logs exclude tokens, raw webhook secrets, and full Markdown. Error messages are redacted and paired with stable codes.
- Metrics cover webhook age/deduplication, reconciliation lag/duration/failure, snapshot age, API/rate-limit consumption, conflict rates, write success, and PR creation latency.
- Persistent Git working trees are forbidden. Temporary bounded data is deleted after the operation; authoritative content is re-readable from GitHub.


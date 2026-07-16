# Folio Authorization Specification

## Evaluation model

Roles are editable capability templates. Services authorize capabilities; they never branch directly on `Admin`, `Member`, or `Guest` names.

For a request, Folio evaluates:

```text
authenticated principal and active workspace
AND active project membership or explicit entry grant
AND role-template capabilities
AND object grant and visibility
AND repository/branch/path policy when applicable
AND current GitHub App installation authorization when applicable
AND agent grant when an agent acts
AND authorizing-user or automation-grant capability when an agent acts
AND risk/confirmation policy
```

An explicit deny, suspended workspace/project/membership/installation, expired grant, stale revision, or failed provider check stops evaluation. Object grants may narrow or add explicitly grantable capabilities for Guests but cannot grant project administration, repository connection, agent administration, or permanent deletion.

Legend: **Full** = default role capability; **Own** = own private objects; **Granted** = explicit object capability required; **No** = absent from the default template. Custom templates may vary within workspace policy.

## Workspace matrix

| Capability | Workspace Owner | Project Admin | Member | Guest | Agent |
|---|---:|---:|---:|---:|---:|
| Read workspace profile/project directory | Full | Full | Full | Granted | Granted |
| Update workspace settings/retention | Full | No | No | No | No |
| Manage workspace owners/members | Full | No | No | No | No |
| Create/archive/restore projects | Full | No | No | No | Granted + R3 |
| Manage identity/SSO policy | Full | No | No | No | No |
| Export workspace audit | Full | No | No | No | No |
| Permanently delete workspace | Full + warned R3 | No | No | No | No |

## Project matrix

| Capability | Admin | Member | Guest | Agent |
|---|---:|---:|---:|---:|
| Read project | Full | Full | Granted/project baseline | Granted |
| Update project settings | Full | No | No | Granted + R3 |
| Manage project memberships/roles | Full | No | No | No initially |
| Manage object grants | Full | No | No | No initially |
| Archive/restore project | Full + R3 | No | No | No initially |
| Read project activity | Full | Full | Granted | Granted |
| Export project data/audit | Full | No | No | No initially |

## Repository and branch matrix

| Capability | Admin | Member | Guest | Agent |
|---|---:|---:|---:|---:|
| List connected repositories/selected branches | Full | Full | Granted | Granted |
| Connect/disconnect repository | Full + R2/R3 | No | No | No initially |
| Select branches/scopes | Full + R2 | No | No | No initially |
| Change Git write policy/path rules | Full + R3 | No | No | No |
| Request reconciliation | Full | Full | No | Granted R1 |
| Read sync status/provenance | Full | Full | Granted | Granted |
| Create branch | Full | If Git policy permits | No | Granted R1/R2 policy |
| Prepare Markdown commit | Full | If Git policy permits | Granted edit + policy | Granted |
| Commit/push Markdown | Full | If Git policy permits | No by default | Granted R2 + confirmation policy |
| Open pull request | Full | If Git policy permits | No by default | Granted R2 + confirmation policy |
| Direct push to allowed branch | Policy + GitHub permits | Policy + GitHub permits | No | Explicit grant + R3 |

GitHub authorization and branch protection are mandatory additional checks; Folio capabilities can never expand them.

## Page matrix

| Capability | Admin | Member | Guest | Agent |
|---|---:|---:|---:|---:|
| Read/search project-visible page | Full | Full | Granted | Granted |
| Create native page | Full | Full | Granted edit | Granted R1 |
| Edit native page | Full | Full | Granted edit | Granted R1 |
| Edit Git-backed Markdown | Repository policy | Repository policy | Granted + repository policy | Granted + repository policy |
| Comment/mention | Full | Full | Granted comment | Granted R1 |
| Move/reorder tree node | Full | Full | Granted edit | Granted R1; bulk R2 |
| Change page grants | Full | No | No | No initially |
| Convert/import/export page | Full | Allowed formats/policy | No | Explicit grant + R2 |
| Archive/restore page/tree node | Full | Full | Granted edit | Granted R1/R2 by scope |
| Permanently delete | Warned R3 | No by default | No | No |

For Git pages, moving a tree node does not move the source file. File creation, rename, or deletion uses the repository matrix and Git write workflow.

## Issue matrix

| Capability | Admin | Member | Guest | Agent |
|---|---:|---:|---:|---:|
| Read/search | Full | Full | Granted | Granted |
| Create issue/sub-issue | Full | Full | Granted create | Granted R1 |
| Edit fields/relationships | Full | Full | Granted edit | Granted R1 |
| Assign human/agent | Full | Full | No by default | Granted R1/R2 by scope |
| Transition status | Full | Workflow permits | Granted transition | Granted R1 |
| Comment/mention/attach | Full | Full | Granted comment | Granted R1 |
| Configure workflow/statuses | Full + R2 | No | No | Explicit R3, not initial |
| Bulk update/archive | Full + R2 | Capability + R2 | No | Granted R2 + confirmation |
| Archive/restore one issue | Full | Full | Granted edit | Granted R1 |
| Permanently delete | Warned R3 | No by default | No | No |

## Task/to-do and calendar matrix

| Capability | Admin | Member | Guest | Agent |
|---|---:|---:|---:|---:|
| Read private personal list | Own | Own | Own | Explicit user delegation only |
| Read shared project list/calendar | Full | Full | Granted | Granted |
| Create/update private to-do | Own | Own | Own | Explicit user delegation R1 |
| Create/update shared to-do | Full | Full | Granted edit | Granted R1 |
| Assign/reschedule shared work | Full | Full | Granted edit | Granted R1/R2 by policy |
| Manage reminders/recurrence | Full/Own | Full/Own | Granted edit | Explicit grant R2 |
| Share private item | Own + R2 | Own + R2 | Own + R2 | Explicit user grant + confirmation |
| Archive/restore | Full/Own | Full/Own | Granted edit | Granted R1/R2 by scope |
| Permanently delete | Warned R3/Own | Warned R3/Own | No | No |

Workspace Owners and project Admins do not automatically read a user's private to-do body; legal/support access requires a separately designed audited process.

## Future graph and Canvas matrix (Phase 6)

| Capability | Admin | Member | Guest | Agent |
|---|---:|---:|---:|---:|
| Search/expand permitted graph | Full | Full | Granted | Granted R0 |
| Read shared Canvas | Full | Full | Granted | Granted R0 |
| Create/edit Canvas layout and native elements | Full | Full | Granted edit | Granted R1 |
| Add an entity card | Full if entity readable | Full if entity readable | Granted + entity readable | Granted R1 + entity readable |
| Read referenced entity content | Entity permission required | Entity permission required | Explicit entity grant | Effective agent/authorizer permission |
| Promote connector to domain relationship | Full | Target-domain capability | Granted narrowly | Granted at target-domain risk |
| Convert sticky to page/issue/to-do | Full | Target-domain create capability | Granted narrowly | Granted R1/R2 by scope |
| Bulk graph rewrite/Canvas conversion | Full + R2/R3 | Capability + R2 | No | Explicit grant + confirmation |
| Share/export Canvas | Full + R2 | Capability + R2 | No by default | Explicit grant + confirmation |
| Permanently delete Canvas/relationship | Warned R3 | No by default | No | No |

Unauthorized entity cards must not reveal title, type, preview, edge metadata, private to-do existence, or hidden counts. Canvas operations that mutate an entity are authorized by the entity's existing matrix, not by Canvas membership alone.

## Agent administration and execution matrix

| Capability | Admin | Member | Guest | Agent |
|---|---:|---:|---:|---:|
| List enabled project agents | Full | Full | Granted | Granted self/context |
| Create/configure/disable agent | Full | No by default | No | No |
| Grant/revoke agent capabilities | Full + R3 | No | No | No |
| Invoke agent interactively | Full | Full | Granted | No recursive invocation by default |
| Create automation grant | Full + R3 | Narrow personal grant + R3 | No | No |
| Read own agent session/tool results | Full | Own | Own | Current session |
| Read another user's agent conversation | No by default | No | No | No |
| Read project agent audit summary | Full | Full | Granted | Granted relevant result |

## Principal-chain rules

- Interactive agent effective capabilities are `agent grants ∩ initiating human capabilities ∩ target policy`.
- Automated execution uses `agent grants ∩ automation grant ∩ current target policy`; the automation grant names the accountable authorizing principal and expires.
- A user losing access immediately prevents new agent actions; queued R2/R3 jobs re-authorize before effect.
- Workers use system capabilities limited to one job kind and target, plus the captured and revalidated principal chain for business effects.
- API clients and integrations use the same principal/grant model and never masquerade as a human.

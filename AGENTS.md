# AGENTS.md

## Project isolation

`experiment/` is an independent, standalone personal project. It is not part of GL-EYE, does not extend GL-EYE, and must not inherit GL-EYE product or engineering assumptions.

- Parent and sibling GL-EYE product documents are not sources of truth for this project.
- GL-EYE's PRD, functional specification, technical design, database schema, MVP boundaries, and document-ownership hierarchy do not apply here.
- Files outside `experiment/` must not be edited unless the user explicitly requests it.
- `../NOTES/TO-DO_GUIDE.md` may be studied as inspiration, but it does not govern this project automatically.
- All project documentation, source code, configuration, tests, generated fixtures, and data definitions must remain inside `experiment/`.

## Local source of truth

Files within `experiment/` define this project's requirements and design. When those files disagree, prefer the most specific project-local document and update conflicting local documentation as part of the same change.

## Working rules

- Keep the project local-first, incremental, and enjoyable to evolve.
- Treat Git repositories as the source of truth for synchronized Markdown content in the first version.
- Store presentation structure and personal workspace metadata in the application, without moving or rewriting source files in Git.
- Preserve task history during normal use; archive instead of permanently deleting unless a user explicitly chooses a warned permanent-delete flow.
- Apply the same authorization and validation rules to agent actions as to UI actions.
- Require confirmation for destructive or broad agent actions and record mutating actions in the activity log.
- Keep secrets, cloned repository working data, databases, caches, and generated output out of version control through project-local ignore rules when implementation begins.


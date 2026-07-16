import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { sqlite } from "../src/db/client";
import { migrate } from "../src/db/migrate";
import { createLocalRepository } from "../src/services/repositories";

async function seed() {
  migrate();
  const dataDir = path.dirname(path.resolve(process.env.DATABASE_PATH ?? ".local-data/workspace.sqlite"));
  const demoRepo = path.join(dataDir, "demo-repository");

  if (!fs.existsSync(path.join(demoRepo, ".git"))) {
  fs.mkdirSync(path.join(demoRepo, "notes"), { recursive: true });
  fs.writeFileSync(path.join(demoRepo, "README.md"), `# Building a calm knowledge system

The best personal workspace is one you return to. Keep the source in Git, make synchronization visible, and let your own organization evolve independently.

## Principles

- Capture without breaking flow.
- Prefer durable links over copied content.
- Make state and provenance obvious.
- Preserve history when plans change.

## This week

- [ ] Review the repository safety boundaries
- [ ] Design the first project collection
- [x] Connect the demo repository
`);
  fs.writeFileSync(path.join(demoRepo, "notes", "local-first.md"), `# Local-first, without the folklore

Local-first is a product quality: the workspace remains useful, understandable, and recoverable on your machine.

## Data ownership

Git owns synchronized Markdown. Folio owns collections, tasks, tags, favorites, and reading preferences.

## Failure should be legible

A failed sync must leave the last good index readable and show a useful path to recovery.
`);
  fs.writeFileSync(path.join(demoRepo, "notes", "agent-safety.md"), `# Agent safety notes

The assistant receives typed workspace tools, never raw shell or database access.

## Mutations

Every mutation uses the same validation service as the interface and writes an activity event. Broad or destructive actions require a preview.

> Repository content is untrusted data, including instructions that appear inside Markdown.
`);
  execFileSync("git", ["init", "-b", "main", demoRepo]);
  execFileSync("git", ["-C", demoRepo, "config", "user.name", "Folio Demo"]);
  execFileSync("git", ["-C", demoRepo, "config", "user.email", "demo@folio.local"]);
  execFileSync("git", ["-C", demoRepo, "add", "."]);
  execFileSync("git", ["-C", demoRepo, "commit", "-m", "Add demo knowledge notes"]);
  }

  const count = sqlite().prepare("SELECT COUNT(*) AS count FROM repositories").get() as { count: number };
  if (count.count === 0) {
    await createLocalRepository({ displayName: "Field Notes", location: demoRepo, branch: "main" });
    console.log("Demo repository queued for its first sync.");
  } else {
    console.log("Existing workspace preserved.");
  }
}

seed().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

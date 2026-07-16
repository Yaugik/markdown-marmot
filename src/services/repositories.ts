import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs, repositories, syncRules, syncSources } from "@/db/schema";
import { newId, now } from "@/lib/ids";
import { validateLocalRepository, validateRepositoryPath } from "@/lib/git";

export type CreateRepositoryInput = { displayName: string; location: string; branch: string };

export async function createLocalRepository(input: CreateRepositoryInput) {
  const location = validateRepositoryPath(input.location);
  await validateLocalRepository(location, input.branch);
  const database = db();
  const timestamp = now();
  const repositoryId = newId();
  const sourceId = newId();
  database.transaction((tx) => {
    tx.insert(repositories).values({
      id: repositoryId, displayName: input.displayName.trim(), kind: "local", location,
      defaultBranch: input.branch, createdAt: timestamp, updatedAt: timestamp,
    }).run();
    tx.insert(syncSources).values({
      id: sourceId, repositoryId, branchName: input.branch, createdAt: timestamp, updatedAt: timestamp,
    }).run();
    tx.insert(syncRules).values({
      id: newId(), syncSourceId: sourceId, ruleType: "include", targetType: "repository",
      pattern: "**/*.{md,markdown}", position: 0, createdAt: timestamp, updatedAt: timestamp,
    }).run();
  });
  const jobId = await queueSync(sourceId);
  return { repositoryId, sourceId, jobId };
}

export async function queueSync(sourceId: string) {
  const database = db();
  const active = await database.select().from(jobs).where(and(eq(jobs.type, "sync-source"), eq(jobs.status, "pending")));
  const duplicate = active.find((job) => (job.payload as { sourceId?: string }).sourceId === sourceId);
  if (duplicate) return duplicate.id;
  const id = newId();
  const timestamp = now();
  await database.insert(jobs).values({
    id, type: "sync-source", payload: { sourceId }, status: "pending", attempts: 0,
    availableAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
  });
  return id;
}

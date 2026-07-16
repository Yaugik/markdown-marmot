import { eq } from "drizzle-orm";
import { sqlite, db } from "@/db/client";
import { activityEvents, documents, repositories, syncRuns, syncSources } from "@/db/schema";
import { git, GitError } from "@/lib/git";
import { newId, now } from "@/lib/ids";
import { parseMarkdown } from "@/lib/markdown";

type TreeEntry = { oid: string; path: string };

function parseTree(raw: string): TreeEntry[] {
  return raw.split("\0").filter(Boolean).flatMap((line) => {
    const match = line.match(/^\d+ blob ([0-9a-f]+)\t(.+)$/);
    return match ? [{ oid: match[1], path: match[2] }] : [];
  }).filter((entry) => /\.(md|markdown)$/i.test(entry.path));
}

export async function syncSource(sourceId: string) {
  const database = db();
  const [source] = await database.select().from(syncSources).where(eq(syncSources.id, sourceId));
  if (!source) throw new Error("Sync source not found");
  const [repository] = await database.select().from(repositories).where(eq(repositories.id, source.repositoryId));
  if (!repository) throw new Error("Repository not found");

  const runId = newId();
  const startedAt = now();
  await database.insert(syncRuns).values({
    id: runId, syncSourceId: sourceId, status: "running", fromCommit: source.lastObservedCommit,
    startedAt, createdAt: startedAt,
  });

  try {
    const commit = String(await git(repository.location, ["rev-parse", "--verify", `${source.branchName}^{commit}`])).trim();
    const rawTree = String(await git(repository.location, ["ls-tree", "-r", "-z", commit]));
    const entries = parseTree(rawTree);
    const existing = await database.select().from(documents).where(eq(documents.syncSourceId, sourceId));
    const byPath = new Map(existing.map((doc) => [doc.sourcePath, doc]));
    const observedPaths = new Set(entries.map((entry) => entry.path));
    let added = 0, changed = 0, unchanged = 0, removed = 0;

    for (const entry of entries) {
      const previous = byPath.get(entry.path);
      if (previous?.blobOid === entry.oid && previous.available) {
        unchanged += 1;
        continue;
      }
      const contentBuffer = await git(repository.location, ["cat-file", "blob", entry.oid], "buffer") as Buffer;
      if (contentBuffer.byteLength > 2 * 1024 * 1024) continue;
      const markdown = contentBuffer.toString("utf8");
      if (markdown.includes("\uFFFD")) continue;
      const parsed = parseMarkdown(markdown, entry.path.split("/").at(-1) ?? entry.path);
      const timestamp = now();
      const documentId = previous?.id ?? newId();
      sqlite().transaction(() => {
        sqlite().prepare(`
          INSERT INTO documents (id,sync_source_id,source_path,title,blob_oid,commit_oid,content_hash,markdown,rendered_html,extracted_text,available,last_indexed_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(sync_source_id,source_path) DO UPDATE SET title=excluded.title,blob_oid=excluded.blob_oid,commit_oid=excluded.commit_oid,
            content_hash=excluded.content_hash,markdown=excluded.markdown,rendered_html=excluded.rendered_html,extracted_text=excluded.extracted_text,
            available=1,last_indexed_at=excluded.last_indexed_at,updated_at=excluded.updated_at
        `).run(documentId, sourceId, entry.path, parsed.title, entry.oid, commit, parsed.contentHash, markdown, parsed.renderedHtml, parsed.extractedText, 1, timestamp, previous?.createdAt ?? timestamp, timestamp);
        sqlite().prepare("DELETE FROM headings WHERE document_id = ?").run(documentId);
        const addHeading = sqlite().prepare("INSERT INTO headings (id,document_id,level,text,slug,position) VALUES (?,?,?,?,?,?)");
        parsed.headings.forEach((heading) => addHeading.run(newId(), documentId, heading.level, heading.text, heading.slug, heading.position));
        sqlite().prepare("DELETE FROM document_search WHERE document_id = ?").run(documentId);
        sqlite().prepare("INSERT INTO document_search (document_id,title,source_path,headings,body) VALUES (?,?,?,?,?)")
          .run(documentId, parsed.title, entry.path, parsed.headings.map((heading) => heading.text).join(" "), parsed.extractedText);
      })();
      if (previous) changed += 1;
      else added += 1;
    }

    for (const previous of existing) {
      if (previous.available && !observedPaths.has(previous.sourcePath)) {
        await database.update(documents).set({ available: false, updatedAt: now() }).where(eq(documents.id, previous.id));
        sqlite().prepare("DELETE FROM document_search WHERE document_id = ?").run(previous.id);
        removed += 1;
      }
    }

    const finishedAt = now();
    database.transaction((tx) => {
      tx.update(syncSources).set({ lastObservedCommit: commit, updatedAt: finishedAt }).where(eq(syncSources.id, sourceId)).run();
      tx.update(repositories).set({ lastSuccessfulSyncAt: finishedAt, updatedAt: finishedAt }).where(eq(repositories.id, repository.id)).run();
      tx.update(syncRuns).set({ status: "succeeded", toCommit: commit, addedCount: added, changedCount: changed, removedCount: removed, unchangedCount: unchanged, finishedAt }).where(eq(syncRuns.id, runId)).run();
      tx.insert(activityEvents).values({
        id: newId(), actorType: "worker", action: "repository.synced", entityType: "repository", entityId: repository.id,
        summary: `Synced ${repository.displayName}: ${added} added, ${changed} changed, ${removed} removed`, metadata: { runId }, createdAt: finishedAt,
      }).run();
    });
    return { runId, added, changed, removed, unchanged };
  } catch (error) {
    const finishedAt = now();
    const code = error instanceof GitError ? error.code : "SYNC_FAILED";
    const message = error instanceof Error ? error.message.slice(0, 500) : "Synchronization failed";
    await database.update(syncRuns).set({ status: "failed", errorCode: code, errorMessage: message, finishedAt }).where(eq(syncRuns.id, runId));
    throw error;
  }
}

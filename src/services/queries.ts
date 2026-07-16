import { sqlite } from "@/db/client";

export type DocumentSummary = {
  id: string; title: string; source_path: string; updated_at: string; repository_name: string;
  branch_name: string; available: number; excerpt: string;
};

export function getDashboardData() {
  const database = sqlite();
  const documents = database.prepare(`
    SELECT d.id,d.title,d.source_path,d.updated_at,r.display_name repository_name,s.branch_name,d.available,
      substr(d.extracted_text,1,180) excerpt
    FROM documents d JOIN sync_sources s ON s.id=d.sync_source_id JOIN repositories r ON r.id=s.repository_id
    WHERE d.available=1 ORDER BY d.updated_at DESC LIMIT 8
  `).all() as DocumentSummary[];
  const repositories = database.prepare(`
    SELECT r.id,r.display_name,r.location,r.default_branch,r.last_successful_sync_at,
      (SELECT COUNT(*) FROM documents d JOIN sync_sources s2 ON s2.id=d.sync_source_id WHERE s2.repository_id=r.id AND d.available=1) document_count,
      (SELECT status FROM sync_runs sr JOIN sync_sources s3 ON s3.id=sr.sync_source_id WHERE s3.repository_id=r.id ORDER BY sr.created_at DESC LIMIT 1) sync_status,
      (SELECT id FROM sync_sources WHERE repository_id=r.id LIMIT 1) source_id
    FROM repositories r WHERE r.enabled=1 ORDER BY r.created_at
  `).all() as Array<{ id:string; display_name:string; location:string; default_branch:string; last_successful_sync_at:string|null; document_count:number; sync_status:string|null; source_id:string }>;
  const activity = database.prepare("SELECT * FROM activity_events ORDER BY created_at DESC LIMIT 5").all() as Array<{ id:string; summary:string; created_at:string }>;
  const stats = database.prepare(`SELECT
    (SELECT COUNT(*) FROM documents WHERE available=1) documents,
    (SELECT COUNT(*) FROM repositories WHERE enabled=1) repositories,
    (SELECT COUNT(*) FROM document_search) indexed_count
  `).get() as { documents:number; repositories:number; indexed_count:number };
  return { documents, repositories, activity, stats };
}

export function getDocument(id: string) {
  return sqlite().prepare(`
    SELECT d.*,r.display_name repository_name,r.location,s.branch_name
    FROM documents d JOIN sync_sources s ON s.id=d.sync_source_id JOIN repositories r ON r.id=s.repository_id
    WHERE d.id=?
  `).get(id) as (DocumentSummary & { rendered_html:string; commit_oid:string; last_indexed_at:string; location:string }) | undefined;
}

export function searchDocuments(query: string) {
  if (!query.trim()) return [];
  const safe = query.trim().replace(/["']/g, " ").split(/\s+/).filter(Boolean).map((term) => `"${term}"*`).join(" ");
  return sqlite().prepare(`
    SELECT d.id,d.title,d.source_path,d.updated_at,r.display_name repository_name,s.branch_name,d.available,
      snippet(document_search,4,'<mark>','</mark>',' … ',24) excerpt
    FROM document_search JOIN documents d ON d.id=document_search.document_id
      JOIN sync_sources s ON s.id=d.sync_source_id JOIN repositories r ON r.id=s.repository_id
    WHERE document_search MATCH ? AND d.available=1 ORDER BY rank LIMIT 30
  `).all(safe) as DocumentSummary[];
}

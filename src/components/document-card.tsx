import Link from "next/link";
import { ArrowUpRight, FileText } from "lucide-react";
import type { DocumentSummary } from "@/services/queries";

function relativeDate(value: string) {
  const days = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000));
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : `${days} days ago`;
}

export function DocumentCard({ document }: { document: DocumentSummary }) {
  return (
    <Link className="document-card" href={`/documents/${document.id}`}>
      <div className="doc-icon"><FileText size={18} /></div>
      <div className="doc-card-body">
        <div className="doc-card-top"><span>{document.repository_name}</span><time>{relativeDate(document.updated_at)}</time></div>
        <h3>{document.title}</h3>
        <p dangerouslySetInnerHTML={{ __html: document.excerpt }} />
        <footer><code>{document.source_path}</code><ArrowUpRight size={15} /></footer>
      </div>
    </Link>
  );
}

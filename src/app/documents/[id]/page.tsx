import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, CalendarClock, FileText, GitBranch, ShieldCheck } from "lucide-react";
import { SearchBox } from "@/components/search-box";
import { getDocument } from "@/services/queries";

export const dynamic = "force-dynamic";

export default async function DocumentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const document = getDocument(id);
  if (!document) notFound();
  return <>
    <header className="topbar"><SearchBox /></header>
    <div className="reader-layout">
      <article className="reader">
        <Link href="/documents" className="back-link"><ArrowLeft size={15} /> All documents</Link>
        <div className="reader-heading"><span className="doc-icon large"><FileText size={22} /></span><div><span className="eyebrow">{document.repository_name}</span><h1>{document.title}</h1></div></div>
        <div className="prose" dangerouslySetInnerHTML={{ __html: document.rendered_html }} />
      </article>
      <aside className="provenance">
        <span className="eyebrow">Source provenance</span>
        <h3>Git owns this document</h3>
        <p>Folio renders a safe cached observation. It never rewrites your source.</p>
        <dl>
          <div><dt><GitBranch size={15} /> Repository</dt><dd>{document.repository_name}</dd></div>
          <div><dt><GitBranch size={15} /> Branch</dt><dd>{document.branch_name}</dd></div>
          <div><dt><FileText size={15} /> Path</dt><dd><code>{document.source_path}</code></dd></div>
          <div><dt><CalendarClock size={15} /> Indexed</dt><dd>{new Date(document.last_indexed_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</dd></div>
          <div><dt><ShieldCheck size={15} /> Commit</dt><dd><code>{document.commit_oid.slice(0, 12)}</code></dd></div>
        </dl>
        <div className="safety-note"><ShieldCheck size={16} /><span>Raw HTML and unsafe asset URLs are blocked.</span></div>
      </aside>
    </div>
  </>;
}

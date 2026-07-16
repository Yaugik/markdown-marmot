"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Plus, RefreshCw, X } from "lucide-react";

export function SyncButton({ sourceId }: { sourceId: string }) {
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function sync() {
    setBusy(true);
    await fetch("/api/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId }) });
    setTimeout(() => { router.refresh(); setBusy(false); }, 1200);
  }
  return <button className="icon-button" onClick={sync} disabled={busy} title="Sync repository"><RefreshCw size={16} className={busy ? "spin" : ""} /></button>;
}

export function AddRepository() {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  async function submit(formData: FormData) {
    setBusy(true); setError("");
    const response = await fetch("/api/repositories", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(formData)) });
    const result = await response.json();
    if (!response.ok) { setError(result.error ?? "Could not connect repository"); setBusy(false); return; }
    setOpen(false); setBusy(false); router.refresh();
  }
  return <>
    <button className="primary-button" onClick={() => setOpen(true)}><Plus size={17} /> Connect repository</button>
    {open && <div className="modal-backdrop" role="presentation" onMouseDown={() => setOpen(false)}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="connect-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={() => setOpen(false)} aria-label="Close"><X size={18} /></button>
        <span className="eyebrow">Local source</span>
        <h2 id="connect-title">Connect a Git repository</h2>
        <p>Folio reads committed Markdown only. Your working tree is never changed.</p>
        <form action={submit}>
          <label>Display name<input name="displayName" placeholder="Engineering notes" required maxLength={80} /></label>
          <label>Path inside a mounted workspace root<input name="location" placeholder="/workspace-repos/my-notes" required /></label>
          <label>Branch<input name="branch" defaultValue="main" required /></label>
          {error && <div className="form-error">{error}</div>}
          <button className="primary-button full" disabled={busy}>{busy ? "Validating…" : "Connect and sync"}</button>
        </form>
      </div>
    </div>}
  </>;
}

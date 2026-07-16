"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { GitBranch, GitPullRequest, Play, RefreshCw, ShieldCheck } from "lucide-react";
import styles from "@/app/git/write/write.module.css";

type Envelope<T>={data:T;error?:{message?:string}};
type Branch={id:string;branchName:string;state:string;lastObservedHeadOid:string|null;lastReconciledAt:string|null;revision:number};
type RepositoryLink={id:string;displayName:string;fullName:string;writePolicy:"disabled"|"pull_request_only"|"direct_allowed";state:string;branches:Branch[]};
type GitPage={id:string;source_type:"git";title:string;status:string;revision:number;git_source:{repository_link_id:string;repository_full_name:string;selected_branch_id:string;branch_name:string;source_path:string;head_oid:string;blob_oid:string;content_hash:string};markdown:string;rendered_html:string;plain_text:string};
type Prepared={id:string;operationKind:string;baseHeadOid:string;targetBranch:string;pullRequestBaseBranch:string|null;commitMessage:string;fileOperations:Array<{operation:string;path:string;baseBlobOid:string|null;content?:string}>;normalizedDiff:string;actionDigest:string;riskLevel:"R1"|"R2";state:string;confirmationId:string|null;providerResult:Record<string,unknown>|null;revision:number;lastErrorCode:string|null;lastErrorMessage:string|null};

async function api<T>(url:string,init?:RequestInit):Promise<T>{const response=await fetch(url,{cache:"no-store",...init});const payload=await response.json().catch(()=>({})) as Envelope<T>;if(!response.ok)throw new Error(payload.error?.message??`Request failed (${response.status})`);return payload.data;}
const key=(prefix:string)=>`${prefix}-${crypto.randomUUID()}`;

export function GitWriteWorkspace({workspaceId,projectId,initialPageId}:{workspaceId?:string;projectId?:string;initialPageId?:string}){
  const [links,setLinks]=useState<RepositoryLink[]>([]);
  const [pageId,setPageId]=useState(initialPageId??"");
  const [page,setPage]=useState<GitPage|null>(null);
  const [content,setContent]=useState("");
  const [operationKind,setOperationKind]=useState<"commit_and_pull_request"|"direct_update">("commit_and_pull_request");
  const [targetBranch,setTargetBranch]=useState(`folio/update-${Date.now().toString(36)}`);
  const [commitMessage,setCommitMessage]=useState("Update Markdown from Folio");
  const [pullRequestTitle,setPullRequestTitle]=useState("Update Markdown from Folio");
  const [prepared,setPrepared]=useState<Prepared|null>(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const scope=useMemo(()=>workspaceId&&projectId?`workspace_id=${encodeURIComponent(workspaceId)}&project_id=${encodeURIComponent(projectId)}`:null,[workspaceId,projectId]);
  const loadLinks=useCallback(async()=>{if(!scope)return;setLinks(await api<RepositoryLink[]>(`/api/v1/repository-links?${scope}`));},[scope]);
  useEffect(()=>{void loadLinks().catch((value)=>setError(value instanceof Error?value.message:"Unable to load repository links."));},[loadLinks]);
  useEffect(()=>{if(initialPageId&&scope)void loadPage(initialPageId);},[]);// eslint-disable-line react-hooks/exhaustive-deps

  if(!workspaceId||!projectId)return <main className={styles.shell}><section className={styles.notice}><h1>Git Markdown write</h1><p>Open this page with workspace and project identifiers. A page identifier may also be supplied.</p><code>?workspace_id=&lt;uuid&gt;&amp;project_id=&lt;uuid&gt;&amp;page_id=&lt;uuid&gt;</code></section></main>;
  async function action(work:()=>Promise<void>){setBusy(true);setError(null);setNotice(null);try{await work();}catch(value){setError(value instanceof Error?value.message:"Operation failed.");}finally{setBusy(false);}}
  async function loadPage(id=pageId){if(!scope||!id.trim())return;await action(async()=>{const value=await api<GitPage>(`/api/v1/pages/${encodeURIComponent(id.trim())}?${scope}`);if(value.source_type!=="git")throw new Error("Selected page is not Git-backed.");setPage(value);setContent(value.markdown);setPageId(value.id);setTargetBranch(`folio/${value.git_source.source_path.replace(/[^a-zA-Z0-9/-]+/g,"-").replace(/\.(md|markdown)$/i,"").slice(0,120)}-${Date.now().toString(36)}`);});}
  async function prepare(){if(!page)return;await action(async()=>{const payload=await api<{prepared_operation:Prepared}>("/api/v1/git-operations/prepared",{method:"POST",headers:{"content-type":"application/json","idempotency-key":key("git-prepare")},body:JSON.stringify({workspace_id:workspaceId,project_id:projectId,selected_branch_id:page.git_source.selected_branch_id,operation_kind:operationKind,base_head_oid:page.git_source.head_oid,target_branch:operationKind==="direct_update"?page.git_source.branch_name:targetBranch,commit_message:commitMessage,pull_request_title:operationKind==="commit_and_pull_request"?pullRequestTitle:undefined,file_operations:[{operation:"upsert",path:page.git_source.source_path,base_blob_oid:page.git_source.blob_oid,content}]})});setPrepared(payload.prepared_operation);setNotice(payload.prepared_operation.riskLevel==="R2"?"Review the diff and approve the R2 confirmation before execution.":"Review the diff, then queue execution.");});}
  async function approve(){if(!prepared?.confirmationId)return;await action(async()=>{await api(`/api/v1/git-operations/prepared/${prepared.id}/confirm`,{method:"POST",headers:{"content-type":"application/json","idempotency-key":key("git-confirm")},body:JSON.stringify({workspace_id:workspaceId,project_id:projectId,confirmation_id:prepared.confirmationId,action_digest:prepared.actionDigest,expected_revision:1})});setNotice("Confirmation approved. The prepared write can now be queued.");});}
  async function execute(){if(!prepared)return;await action(async()=>{await api(`/api/v1/git-operations/prepared/${prepared.id}/execute`,{method:"POST",headers:{"content-type":"application/json","idempotency-key":key("git-execute")},body:JSON.stringify({workspace_id:workspaceId,project_id:projectId,expected_revision:prepared.revision})});setNotice("Git write was queued for the durable worker.");await refreshPrepared();});}
  async function refreshPrepared(){if(!prepared||!scope)return;const value=await api<Prepared>(`/api/v1/git-operations/prepared/${prepared.id}?${scope}`);setPrepared(value);}
  const selectedLink=page?links.find((link)=>link.id===page.git_source.repository_link_id):null;

  return <main className={styles.shell}>
    <header className={styles.header}><div><h1>Git Markdown write</h1><p>Review exact Git provenance, prepare a bounded diff, obtain confirmation when required, and queue commit/ref/pull-request execution.</p></div><button className={styles.button} onClick={()=>void refreshPrepared()} disabled={busy||!prepared}><RefreshCw size={16}/> Refresh</button></header>
    {error&&<p className={styles.error}>{error}</p>}{notice&&<p className={styles.noticeText}>{notice}</p>}
    <div className={styles.grid}>
      <aside className={styles.panel}><h2>Source</h2><label>Git page UUID<input value={pageId} onChange={(event)=>setPageId(event.target.value)} placeholder="Page UUID"/></label><button className={styles.buttonPrimary} onClick={()=>void loadPage()} disabled={busy||!pageId.trim()}>Load Git page</button>{page&&<div className={styles.meta}><strong>{page.title}</strong><span>{page.git_source.repository_full_name}</span><span>{page.git_source.branch_name} · {page.git_source.source_path}</span><code>{page.git_source.head_oid}</code><code>{page.git_source.blob_oid}</code><span>Policy: {selectedLink?.writePolicy??"unknown"}</span></div>}<h2>Operation</h2><label>Workflow<select value={operationKind} onChange={(event)=>setOperationKind(event.target.value as typeof operationKind)}><option value="commit_and_pull_request">New branch + pull request</option><option value="direct_update" disabled={selectedLink?.writePolicy!=="direct_allowed"}>Direct selected-branch update</option></select></label>{operationKind==="commit_and_pull_request"&&<label>Working branch<input value={targetBranch} onChange={(event)=>setTargetBranch(event.target.value)}/></label>}<label>Commit message<input value={commitMessage} onChange={(event)=>setCommitMessage(event.target.value)}/></label>{operationKind==="commit_and_pull_request"&&<label>Pull request title<input value={pullRequestTitle} onChange={(event)=>setPullRequestTitle(event.target.value)}/></label>}<button className={styles.buttonPrimary} onClick={()=>void prepare()} disabled={busy||!page||content===page.markdown}><GitBranch size={16}/> Prepare diff</button></aside>
      <section className={styles.panel}><h2>Markdown</h2><textarea className={styles.editor} value={content} onChange={(event)=>{setContent(event.target.value);setPrepared(null);}} disabled={!page}/>{prepared&&<><div className={styles.summary}><span><ShieldCheck size={15}/> {prepared.riskLevel}</span><span>{prepared.state}</span><span>revision {prepared.revision}</span></div><pre className={styles.diff}>{prepared.normalizedDiff}</pre><div className={styles.actions}>{prepared.riskLevel==="R2"&&prepared.confirmationId&&prepared.state==="prepared"&&<button className={styles.button} onClick={()=>void approve()} disabled={busy}>Approve confirmation</button>}<button className={styles.buttonPrimary} onClick={()=>void execute()} disabled={busy||prepared.state!=="prepared"}><Play size={16}/> Queue execution</button></div>{prepared.providerResult&&<div className={styles.result}><GitPullRequest size={18}/><pre>{JSON.stringify(prepared.providerResult,null,2)}</pre></div>}{prepared.lastErrorMessage&&<p className={styles.error}>{prepared.lastErrorCode}: {prepared.lastErrorMessage}</p>}</>}</section>
    </div>
  </main>;
}

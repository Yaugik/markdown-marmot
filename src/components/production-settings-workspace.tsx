"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Database, Github, HardDrive, RefreshCw, ShieldCheck, UserPlus } from "lucide-react";
import styles from "@/app/settings/integrations/settings.module.css";

type Envelope<T>={data:T;error?:{message?:string}};
type Readiness={ready:boolean;environment:string;checks:Array<{key:string;status:"pass"|"warn"|"fail";message:string}>;latestMigration:string|null;appliedMigration:string|null;latestBackupAt:string|null;latestRestoreAt:string|null;storageProvider:string|null};
type Member={principal_id:string;display_name:string;email:string;workspace_role:string;workspace_status:string;revision:number;projects:Array<{project_id:string;project_key:string;role_template_key:string;status:string}>};
type Invitation={id:string;email:string;status:string;expires_at:string;revision:number};
type Installation={id:string;accountLogin:string;accountType:string;state:string;repositorySelection:string;revision:number};
type Repository={id:string;installationId:string;fullName:string;defaultBranch:string;state:string;isPrivate:boolean};
type Branch={id:string;branchName:string;state:string;lastObservedHeadOid:string|null;lastReconciledAt:string|null;revision:number};
type RepositoryLink={id:string;displayName:string;fullName:string;writePolicy:string;state:string;revision:number;branches:Branch[]};
type StoragePolicy={provider:"filesystem"|"s3";bucket:string|null;region:string|null;endpoint:string|null;keyPrefix:string;credentialRef:string|null;encryptionKeyRef:string|null;forcePathStyle:boolean;state:string;revision:number}|null;

async function api<T>(url:string,init?:RequestInit):Promise<T>{const response=await fetch(url,{cache:"no-store",...init});const payload=await response.json().catch(()=>({})) as Envelope<T>;if(!response.ok)throw new Error(payload.error?.message??`Request failed (${response.status})`);return payload.data;}
const key=(prefix:string)=>`${prefix}-${crypto.randomUUID()}`;

export function ProductionSettingsWorkspace({workspaceId,projectId}:{workspaceId?:string;projectId?:string}){
  const [readiness,setReadiness]=useState<Readiness|null>(null);
  const [members,setMembers]=useState<Member[]>([]);
  const [invitations,setInvitations]=useState<Invitation[]>([]);
  const [installations,setInstallations]=useState<Installation[]>([]);
  const [repositories,setRepositories]=useState<Repository[]>([]);
  const [links,setLinks]=useState<RepositoryLink[]>([]);
  const [storage,setStorage]=useState<StoragePolicy>(null);
  const [selectedInstallation,setSelectedInstallation]=useState("");
  const [selectedRepository,setSelectedRepository]=useState("");
  const [selectedLink,setSelectedLink]=useState("");
  const [inviteEmail,setInviteEmail]=useState("");
  const [branchName,setBranchName]=useState("main");
  const [storageBucket,setStorageBucket]=useState("");
  const [storageRegion,setStorageRegion]=useState("");
  const [storageEndpoint,setStorageEndpoint]=useState("");
  const [storageCredentialRef,setStorageCredentialRef]=useState("secret:folio/object-storage");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);

  const workspaceScope=useMemo(()=>workspaceId?`workspace_id=${encodeURIComponent(workspaceId)}`:null,[workspaceId]);
  const projectScope=useMemo(()=>workspaceId&&projectId?`${workspaceScope}&project_id=${encodeURIComponent(projectId)}`:null,[workspaceId,projectId,workspaceScope]);
  const load=useCallback(async()=>{if(!workspaceScope||!workspaceId)return;setBusy(true);setError(null);try{const requests:[Promise<Readiness>,Promise<Member[]>,Promise<Invitation[]>,Promise<Installation[]>,Promise<StoragePolicy>,Promise<RepositoryLink[]>?]=[
    api<Readiness>(`/api/v1/operational-readiness?${workspaceScope}`),
    api<Member[]>(`/api/v1/workspaces/${workspaceId}/members`),
    api<Invitation[]>(`/api/v1/workspaces/${workspaceId}/invitations`),
    api<Installation[]>(`/api/v1/github/installations?${workspaceScope}`),
    api<StoragePolicy>(`/api/v1/workspaces/${workspaceId}/storage-policy`),
  ];if(projectScope)requests.push(api<RepositoryLink[]>(`/api/v1/repository-links?${projectScope}`));const [ready,memberList,inviteList,installationList,storagePolicy,linkList]=await Promise.all(requests);setReadiness(ready);setMembers(memberList);setInvitations(inviteList);setInstallations(installationList);setStorage(storagePolicy);setLinks(linkList??[]);if(!selectedInstallation&&installationList[0])setSelectedInstallation(installationList[0].id);if(!selectedLink&&linkList?.[0])setSelectedLink(linkList[0].id);if(storagePolicy){setStorageBucket(storagePolicy.bucket??"");setStorageRegion(storagePolicy.region??"");setStorageEndpoint(storagePolicy.endpoint??"");setStorageCredentialRef(storagePolicy.credentialRef??"");}}catch(value){setError(value instanceof Error?value.message:"Unable to load production settings.");}finally{setBusy(false);}},[projectScope,selectedInstallation,selectedLink,workspaceId,workspaceScope]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{if(!workspaceId||!selectedInstallation){setRepositories([]);return;}void api<Repository[]>(`/api/v1/github/installations/${selectedInstallation}/repositories?workspace_id=${encodeURIComponent(workspaceId)}`).then((items)=>{setRepositories(items);if(!selectedRepository&&items[0])setSelectedRepository(items[0].id);}).catch((value)=>setError(value instanceof Error?value.message:"Unable to load repositories."));},[selectedInstallation,selectedRepository,workspaceId]);

  if(!workspaceId)return <main className={styles.shell}><section className={styles.notice}><h1>Production & GitHub settings</h1><p>Open this page with a workspace identifier and, for repository linking, a project identifier.</p><code>?workspace_id=&lt;uuid&gt;&amp;project_id=&lt;uuid&gt;</code></section></main>;
  async function action(work:()=>Promise<void>){setBusy(true);setError(null);setNotice(null);try{await work();await load();}catch(value){setError(value instanceof Error?value.message:"Operation failed.");}finally{setBusy(false);}}
  const invite=()=>action(async()=>{const result=await api<{invitation:Invitation;token:string}>(`/api/v1/workspaces/${workspaceId}/invitations`,{method:"POST",headers:{"content-type":"application/json","idempotency-key":key("invite")},body:JSON.stringify({email:inviteEmail,project_assignments:projectId?[{project_id:projectId,role_template_key:"member"}]:[]})});setNotice(`Invitation created. Share this one-time token securely: ${result.token}`);setInviteEmail("");});
  const connectGitHub=()=>action(async()=>{const result=await api<{setup:{installationUrl:string}}>("/api/v1/github/installations",{method:"POST",headers:{"content-type":"application/json","idempotency-key":key("github-install")},body:JSON.stringify({workspace_id:workspaceId,redirect_path:`/settings/integrations?workspace_id=${encodeURIComponent(workspaceId)}${projectId?`&project_id=${encodeURIComponent(projectId)}`:""}`})});window.location.assign(result.setup.installationUrl);});
  const refreshRepositories=()=>action(async()=>{if(!selectedInstallation)return;await api(`/api/v1/github/installations/${selectedInstallation}/repositories`,{method:"POST",headers:{"content-type":"application/json","idempotency-key":key("github-repos")},body:JSON.stringify({workspace_id:workspaceId})});const items=await api<Repository[]>(`/api/v1/github/installations/${selectedInstallation}/repositories?workspace_id=${encodeURIComponent(workspaceId)}`);setRepositories(items);});
  const linkRepository=()=>action(async()=>{if(!projectId||!selectedRepository)return;await api("/api/v1/repository-links",{method:"POST",headers:{"content-type":"application/json","idempotency-key":key("repository-link")},body:JSON.stringify({workspace_id:workspaceId,project_id:projectId,repository_id:selectedRepository,write_policy:"pull_request_only",include_rules:["**/*.md","**/*.markdown"],exclude_rules:[]})});});
  const selectBranch=()=>action(async()=>{if(!projectId||!selectedLink)return;await api(`/api/v1/repository-links/${selectedLink}/branches`,{method:"POST",headers:{"content-type":"application/json","idempotency-key":key("branch")},body:JSON.stringify({workspace_id:workspaceId,project_id:projectId,branch_name:branchName})});});
  const reconcile=(branchId:string)=>action(async()=>{if(!projectId)return;await api(`/api/v1/selected-git-branches/${branchId}/reconcile`,{method:"POST",headers:{"content-type":"application/json","idempotency-key":key("reconcile")},body:JSON.stringify({workspace_id:workspaceId,project_id:projectId})});setNotice("Reconciliation was queued.");});
  const saveStorage=()=>action(async()=>{await api(`/api/v1/workspaces/${workspaceId}/storage-policy`,{method:"PUT",headers:{"content-type":"application/json","idempotency-key":key("storage-policy")},body:JSON.stringify({provider:"s3",bucket:storageBucket,region:storageRegion,endpoint:storageEndpoint||null,credential_ref:storageCredentialRef,key_prefix:"folio",force_path_style:false,state:"active",expected_revision:storage?.revision})});});

  return <main className={styles.shell}>
    <header className={styles.header}><div><h1>Production & GitHub settings</h1><p>Phase 0 readiness, team administration, storage policy, GitHub App onboarding, repositories, branches, and reconciliation.</p></div><button className={styles.button} onClick={()=>void load()} disabled={busy}><RefreshCw size={16}/> Refresh</button></header>
    {error&&<p className={styles.error}>{error}</p>}{notice&&<p className={styles.noticeText}>{notice}</p>}
    <div className={styles.grid}>
      <section className={styles.panel}><div className={styles.panelHeader}><ShieldCheck size={18}/><h2>Readiness</h2><span data-status={readiness?.ready?"pass":"fail"}>{readiness?.ready?"Ready":"Not ready"}</span></div><div className={styles.stack}>{readiness?.checks.map((check)=><article className={styles.check} key={check.key} data-status={check.status}><strong>{check.key.replaceAll("_"," ")}</strong><p>{check.message}</p></article>)}</div></section>
      <section className={styles.panel}><div className={styles.panelHeader}><UserPlus size={18}/><h2>Members & invitations</h2></div><div className={styles.row}><input value={inviteEmail} onChange={(event)=>setInviteEmail(event.target.value)} placeholder="member@example.com"/><button className={styles.buttonPrimary} disabled={busy||!inviteEmail.trim()} onClick={()=>void invite()}>Invite</button></div><div className={styles.list}>{members.map((member)=><article key={member.principal_id}><strong>{member.display_name}</strong><small>{member.email} · {member.workspace_role} · {member.workspace_status}</small></article>)}{invitations.filter((item)=>item.status==="pending").map((item)=><article key={item.id}><strong>{item.email}</strong><small>Pending until {new Date(item.expires_at).toLocaleString()}</small></article>)}</div></section>
      <section className={styles.panel}><div className={styles.panelHeader}><HardDrive size={18}/><h2>Object storage policy</h2></div><div className={styles.fields}><label>Bucket<input value={storageBucket} onChange={(event)=>setStorageBucket(event.target.value)}/></label><label>Region<input value={storageRegion} onChange={(event)=>setStorageRegion(event.target.value)}/></label><label>Endpoint<input value={storageEndpoint} onChange={(event)=>setStorageEndpoint(event.target.value)} placeholder="https://s3.example.com"/></label><label>Credential reference<input value={storageCredentialRef} onChange={(event)=>setStorageCredentialRef(event.target.value)}/></label></div><button className={styles.buttonPrimary} disabled={busy||!storageBucket||!storageRegion||!storageCredentialRef} onClick={()=>void saveStorage()}>Save S3 policy</button></section>
      <section className={styles.panel}><div className={styles.panelHeader}><Github size={18}/><h2>GitHub App</h2></div><button className={styles.buttonPrimary} disabled={busy} onClick={()=>void connectGitHub()}>Connect installation</button><div className={styles.fields}><label>Installation<select value={selectedInstallation} onChange={(event)=>setSelectedInstallation(event.target.value)}><option value="">Select installation</option>{installations.map((item)=><option key={item.id} value={item.id}>{item.accountLogin} · {item.state}</option>)}</select></label></div><button className={styles.button} disabled={busy||!selectedInstallation} onClick={()=>void refreshRepositories()}>Refresh repositories</button></section>
      {projectId&&<section className={styles.panel}><div className={styles.panelHeader}><Database size={18}/><h2>Project repository</h2></div><div className={styles.fields}><label>Available repository<select value={selectedRepository} onChange={(event)=>setSelectedRepository(event.target.value)}><option value="">Select repository</option>{repositories.filter((item)=>item.state==="available").map((item)=><option key={item.id} value={item.id}>{item.fullName}</option>)}</select></label></div><button className={styles.buttonPrimary} disabled={busy||!selectedRepository} onClick={()=>void linkRepository()}>Link with PR-only policy</button><div className={styles.list}>{links.map((link)=><article key={link.id}><strong>{link.displayName} · {link.fullName}</strong><small>{link.writePolicy} · {link.state}</small>{link.branches.map((branch)=><div className={styles.branch} key={branch.id}><span>{branch.branchName} · {branch.lastObservedHeadOid?.slice(0,10)??"not reconciled"}</span><button className={styles.button} onClick={()=>void reconcile(branch.id)} disabled={busy}>Reconcile</button></div>)}</article>)}</div><div className={styles.row}><select value={selectedLink} onChange={(event)=>setSelectedLink(event.target.value)}><option value="">Select linked repository</option>{links.map((link)=><option key={link.id} value={link.id}>{link.displayName}</option>)}</select><input value={branchName} onChange={(event)=>setBranchName(event.target.value)} placeholder="main"/><button className={styles.buttonPrimary} disabled={busy||!selectedLink||!branchName.trim()} onClick={()=>void selectBranch()}>Add branch</button></div></section>}
    </div>
  </main>;
}

import type { Pool } from "pg";
import { postgresPool } from "@/db/postgres";
import { establishTenantContext } from "@/db/tenant";
import { authorizePageCapability } from "@/services/page-access";
import { FoundationServiceError } from "@/services/foundation/errors";
import { inTransaction } from "@/services/foundation/internal";

export type GitPage = {
  id:string;workspaceId:string;projectId:string;sourceType:"git";title:string;
  status:"active"|"archived"|"unavailable";revision:number;
  repositoryLinkId:string;repositoryFullName:string;selectedBranchId:string;branchName:string;
  sourcePath:string;snapshotId:string;snapshotFileId:string;headOid:string;blobOid:string;
  contentHash:string;markdown:string;renderedHtml:string;plainText:string;
  createdAt:string;updatedAt:string;
};

type GitPageRow={id:string;workspace_id:string;project_id:string;title:string;status:GitPage["status"];revision:string;repository_link_id:string;full_name:string;selected_branch_id:string;branch_name:string;source_path:string;snapshot_id:string;current_snapshot_file_id:string;current_head_oid:string;current_blob_oid:string;content_hash:string;markdown:string;rendered_html:string;plain_text:string;created_at:Date;updated_at:Date};

export async function readGitPage(input:{workspaceId:string;projectId:string;pageId:string},principalId:string,pool:Pool=postgresPool()):Promise<GitPage>{return inTransaction(pool,async(client)=>{await establishTenantContext(client,input.workspaceId,principalId);await authorizePageCapability(client,{...input,principalId,capability:"page.read"});const result=await client.query<GitPageRow>(`SELECT page.id,page.workspace_id,page.project_id,page.title,page.status,page.revision,
    link.id repository_link_id,repository.full_name,branch.id selected_branch_id,branch.branch_name,
    git_page.source_path,snapshot_file.snapshot_id,git_page.current_snapshot_file_id,
    git_page.current_head_oid,git_page.current_blob_oid,git_page.content_hash,git_page.markdown,
    git_page.rendered_html,git_page.plain_text,page.created_at,page.updated_at
    FROM pages page
    JOIN git_pages git_page ON git_page.workspace_id=page.workspace_id AND git_page.project_id=page.project_id AND git_page.page_id=page.id
    JOIN selected_git_branches branch ON branch.workspace_id=git_page.workspace_id AND branch.project_id=git_page.project_id AND branch.id=git_page.selected_branch_id
    JOIN project_repository_links link ON link.workspace_id=branch.workspace_id AND link.project_id=branch.project_id AND link.id=branch.repository_link_id
    JOIN github_repositories repository ON repository.workspace_id=link.workspace_id AND repository.id=link.repository_id
    JOIN git_snapshot_files snapshot_file ON snapshot_file.workspace_id=git_page.workspace_id AND snapshot_file.project_id=git_page.project_id AND snapshot_file.id=git_page.current_snapshot_file_id
    WHERE page.workspace_id=$1 AND page.project_id=$2 AND page.id=$3 AND page.source_type='git'`,[input.workspaceId,input.projectId,input.pageId]);const row=result.rows[0];if(!row)throw new FoundationServiceError("NOT_FOUND","Git-backed page was not found.");return{id:row.id,workspaceId:row.workspace_id,projectId:row.project_id,sourceType:"git",title:row.title,status:row.status,revision:Number(row.revision),repositoryLinkId:row.repository_link_id,repositoryFullName:row.full_name,selectedBranchId:row.selected_branch_id,branchName:row.branch_name,sourcePath:row.source_path,snapshotId:row.snapshot_id,snapshotFileId:row.current_snapshot_file_id,headOid:row.current_head_oid,blobOid:row.current_blob_oid,contentHash:row.content_hash,markdown:row.markdown,renderedHtml:row.rendered_html,plainText:row.plain_text,createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()};});}

export async function readProjectPage(input:{workspaceId:string;projectId:string;pageId:string},principalId:string,pool:Pool=postgresPool()){
  const source=await inTransaction(pool,async(client)=>{await establishTenantContext(client,input.workspaceId,principalId);await authorizePageCapability(client,{...input,principalId,capability:"page.read"});const result=await client.query<{source_type:"native"|"git"}>(`SELECT source_type FROM pages WHERE workspace_id=$1 AND project_id=$2 AND id=$3`,[input.workspaceId,input.projectId,input.pageId]);if(!result.rows[0])throw new FoundationServiceError("NOT_FOUND","Page was not found.");return result.rows[0].source_type;});
  if(source==="git")return readGitPage(input,principalId,pool);
  const { readNativePage }=await import("@/services/pages");
  return readNativePage(input,principalId,pool);
}

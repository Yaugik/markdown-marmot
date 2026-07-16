import { GitHubProviderError, installationGitHubRequest } from "@/integrations/github/app-client";

const encodedPath=(value:string)=>value.split("/").map(encodeURIComponent).join("/");

export async function getGitHubContentMetadata(
  installationId:number,owner:string,repository:string,path:string,ref:string,
):Promise<{sha:string;size:number;type:string}|null>{
  try{
    const result=await installationGitHubRequest<{sha:string;size:number;type:string}>(installationId,
      `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${encodedPath(path)}?ref=${encodeURIComponent(ref)}`);
    return result.data;
  }catch(error){
    if(error instanceof GitHubProviderError&&error.code==="GITHUB_NOT_FOUND")return null;
    throw error;
  }
}

export async function findGitHubPullRequest(
  installationId:number,owner:string,repository:string,input:{head:string;base:string},
){
  const result=await installationGitHubRequest<Array<{
    number:number;node_id:string;html_url:string;state:string;title:string;
    head:{ref:string};base:{ref:string};created_at:string;updated_at:string;
  }>>(installationId,`repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls?state=all&head=${encodeURIComponent(`${owner}:${input.head}`)}&base=${encodeURIComponent(input.base)}&per_page=20`);
  return result.data.find((pull)=>pull.head.ref===input.head&&pull.base.ref===input.base)??null;
}

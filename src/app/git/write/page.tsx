import { GitWriteWorkspace } from "@/components/git-write-workspace";

export default async function GitWritePage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}){
  const params=await searchParams;
  const value=(key:string)=>typeof params[key]==="string"?params[key] as string:undefined;
  return <GitWriteWorkspace workspaceId={value("workspace_id")} projectId={value("project_id")} initialPageId={value("page_id")} />;
}

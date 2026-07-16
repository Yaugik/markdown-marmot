import { ProductionSettingsWorkspace } from "@/components/production-settings-workspace";

export default async function IntegrationsSettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string,string|string[]|undefined>>;
}) {
  const params=await searchParams;
  const value=(key:string)=>typeof params[key]==="string"?params[key] as string:undefined;
  return <ProductionSettingsWorkspace workspaceId={value("workspace_id")} projectId={value("project_id")} />;
}

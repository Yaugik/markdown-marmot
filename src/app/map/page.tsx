import type { Metadata } from "next";
import { KnowledgeMapWorkspace } from "@/components/knowledge-map-workspace";

export const metadata: Metadata = {
  title: "Map & Canvas",
  description: "Permission-filtered graph exploration, typed relationships, and revisioned Canvas scenes.",
};
export const dynamic = "force-dynamic";

export default async function MapScreen({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string; project_id?: string }>;
}) {
  const params = await searchParams;
  return <KnowledgeMapWorkspace workspaceId={params.workspace_id} projectId={params.project_id} />;
}

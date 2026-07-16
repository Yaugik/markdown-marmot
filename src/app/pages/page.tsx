import type { Metadata } from "next";
import { PageWorkspace } from "@/components/page-workspace";

export const metadata: Metadata = {
  title: "Pages",
  description: "Native and Git-backed project knowledge pages.",
};
export const dynamic = "force-dynamic";

export default async function PagesScreen({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string; project_id?: string }>;
}) {
  const params = await searchParams;
  return <PageWorkspace workspaceId={params.workspace_id} projectId={params.project_id} />;
}

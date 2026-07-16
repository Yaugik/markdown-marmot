import type { Metadata } from "next";
import { IssueWorkspace } from "@/components/issue-workspace";

export const metadata: Metadata = {
  title: "Issues",
  description: "Project workflows, issues, portfolio planning, and saved views.",
};
export const dynamic = "force-dynamic";

export default async function IssuesScreen({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string; project_id?: string }>;
}) {
  const params = await searchParams;
  return <IssueWorkspace workspaceId={params.workspace_id} projectId={params.project_id} />;
}

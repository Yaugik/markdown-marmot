import type { Metadata } from "next";
import { ScheduleWorkspace } from "@/components/schedule-workspace";

export const metadata: Metadata = {
  title: "Schedule",
  description: "Private and shared to-dos, reminders, calendars, and scheduling.",
};
export const dynamic = "force-dynamic";

export default async function ScheduleScreen({
  searchParams,
}: {
  searchParams: Promise<{ workspace_id?: string; project_id?: string }>;
}) {
  const params = await searchParams;
  return <ScheduleWorkspace workspaceId={params.workspace_id} projectId={params.project_id} />;
}

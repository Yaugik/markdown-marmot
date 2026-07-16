import { z } from "zod";
import { createLocalRepository } from "@/services/repositories";

const inputSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  location: z.string().trim().min(1).max(500),
  branch: z.string().trim().min(1).max(180).default("main"),
});

export async function POST(request: Request) {
  try {
    const input = inputSchema.parse(await request.json());
    return Response.json(await createLocalRepository(input), { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to connect repository";
    return Response.json({ error: message }, { status: 400 });
  }
}

import { z } from "zod";
import { queueSync } from "@/services/repositories";

const schema = z.object({ sourceId: z.string().uuid() });

export async function POST(request: Request) {
  try {
    const { sourceId } = schema.parse(await request.json());
    return Response.json({ jobId: await queueSync(sourceId) }, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to queue sync";
    return Response.json({ error: message }, { status: 400 });
  }
}

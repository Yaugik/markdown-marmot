import { sqlite } from "@/db/client";
import { postgresPool } from "@/db/postgres";
import { folioDatabaseConfigured, oidcConfigured } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  sqlite().prepare("SELECT 1").get();
  const components: Record<string, string> = { legacy_reader: "ok" };
  if (folioDatabaseConfigured()) {
    await postgresPool().query("SELECT 1");
    components.folio_postgres = "ok";
  } else {
    components.folio_postgres = "not_configured";
  }
  components.managed_oidc = oidcConfigured() ? "configured" : "not_configured";
  return Response.json({ status: "ok", components });
}

import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().url().optional(),
  DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
  DATABASE_CA_CERT_PATH: z.string().min(1).optional(),
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(16).optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_STATE_SIGNING_KEY: z.string().min(43).optional(),
  OIDC_SCOPES: z.string().default("openid profile email"),
  DATABASE_PATH: z.string().min(1).default(".local-data/workspace.sqlite"),
  WORKSPACE_ROOTS: z.string().default(""),
  WORKER_POLL_MS: z.coerce.number().int().positive().default(1000),
  WORKER_LEASE_SECONDS: z.coerce.number().int().positive().default(60),
});

export const env = schema.parse(process.env);

export function folioDatabaseConfigured(): boolean {
  return Boolean(env.DATABASE_URL);
}

export function oidcConfigured(): boolean {
  return Boolean(env.OIDC_ISSUER_URL && env.OIDC_CLIENT_ID && env.OIDC_REDIRECT_URI && env.OIDC_STATE_SIGNING_KEY);
}

export function allowedWorkspaceRoots(): string[] {
  return env.WORKSPACE_ROOTS.split(",").map((root) => root.trim()).filter(Boolean);
}

import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  FOLIO_PUBLIC_URL: z.string().url().optional(),
  DATABASE_URL: z.string().url().optional(),
  DATABASE_SSL: z.enum(["disable", "require"]).default("disable"),
  DATABASE_CA_CERT_PATH: z.string().min(1).optional(),
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  OIDC_CLIENT_SECRET: z.string().min(16).optional(),
  OIDC_REDIRECT_URI: z.string().url().optional(),
  OIDC_STATE_SIGNING_KEY: z.string().min(43).optional(),
  OIDC_SCOPES: z.string().default("openid profile email"),

  OBJECT_STORAGE_DRIVER: z.enum(["filesystem", "s3"]).default("filesystem"),
  OBJECT_STORAGE_ROOT: z.string().min(1).default(".local-data/objects"),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().min(1).optional(),
  S3_BUCKET: z.string().min(1).optional(),
  S3_ACCESS_KEY_ID: z.string().min(1).optional(),
  S3_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  S3_SESSION_TOKEN: z.string().min(1).optional(),
  S3_FORCE_PATH_STYLE: z.coerce.boolean().default(false),
  S3_KEY_PREFIX: z.string().default("folio"),
  S3_SERVER_SIDE_ENCRYPTION: z.enum(["AES256", "aws:kms"]).optional(),
  S3_KMS_KEY_ID: z.string().min(1).optional(),

  GITHUB_APP_ID: z.coerce.number().int().positive().optional(),
  GITHUB_APP_SLUG: z.string().regex(/^[a-z0-9-]+$/).optional(),
  GITHUB_APP_PRIVATE_KEY: z.string().min(64).optional(),
  GITHUB_APP_PRIVATE_KEY_PATH: z.string().min(1).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(24).optional(),
  GITHUB_INSTALL_STATE_SIGNING_KEY: z.string().min(43).optional(),
  GITHUB_API_URL: z.string().url().default("https://api.github.com"),
  GITHUB_WEB_URL: z.string().url().default("https://github.com"),
  GITHUB_APP_CALLBACK_URL: z.string().url().optional(),
  GITHUB_CREDENTIAL_KEY_REF: z.string().min(1).default("env:GITHUB_APP_PRIVATE_KEY"),
  GITHUB_HTTP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  GITHUB_MAX_SNAPSHOT_FILES: z.coerce.number().int().positive().max(100000).default(10000),
  GITHUB_MAX_SNAPSHOT_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),

  DATABASE_PATH: z.string().min(1).default(".local-data/workspace.sqlite"),
  WORKSPACE_ROOTS: z.string().default(""),
  LEGACY_IMPORT_ENABLED: z.coerce.boolean().default(false),
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

export function objectStorageConfigured(): boolean {
  if (env.OBJECT_STORAGE_DRIVER === "filesystem") return env.NODE_ENV !== "production";
  return Boolean(env.S3_ENDPOINT && env.S3_REGION && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
}

export function githubAppConfigured(): boolean {
  return Boolean(
    env.GITHUB_APP_ID
      && env.GITHUB_APP_SLUG
      && (env.GITHUB_APP_PRIVATE_KEY || env.GITHUB_APP_PRIVATE_KEY_PATH)
      && env.GITHUB_WEBHOOK_SECRET
      && env.GITHUB_INSTALL_STATE_SIGNING_KEY
      && env.GITHUB_APP_CALLBACK_URL,
  );
}

export function allowedWorkspaceRoots(): string[] {
  return env.WORKSPACE_ROOTS.split(",").map((root) => root.trim()).filter(Boolean);
}

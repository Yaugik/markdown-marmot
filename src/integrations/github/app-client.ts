import { readFile } from "node:fs/promises";
import { importPKCS8, SignJWT } from "jose";
import { env, githubAppConfigured } from "@/lib/env";

export type GitHubRateLimit = {
  resource: string;
  remaining: number | null;
  limit: number | null;
  resetAt: Date | null;
  retryAfterSeconds: number | null;
};

export class GitHubProviderError extends Error {
  constructor(
    public readonly code:
      | "GITHUB_NOT_CONFIGURED"
      | "GITHUB_UNAUTHORIZED"
      | "GITHUB_NOT_FOUND"
      | "GITHUB_FORBIDDEN"
      | "GITHUB_RATE_LIMITED"
      | "GITHUB_CONFLICT"
      | "GITHUB_PROVIDER_UNAVAILABLE"
      | "GITHUB_RESPONSE_INVALID",
    message: string,
    public readonly status: number | null = null,
    public readonly retryable = false,
    public readonly rateLimit?: GitHubRateLimit,
  ) {
    super(message);
    this.name = "GitHubProviderError";
  }
}

type InstallationToken = { token: string; expiresAt: number };
const installationTokens = new Map<number, InstallationToken>();
let keyPromise: Promise<CryptoKey> | undefined;

async function privateKey(): Promise<CryptoKey> {
  if (!githubAppConfigured()) throw new GitHubProviderError("GITHUB_NOT_CONFIGURED", "GitHub App is not configured.");
  keyPromise ??= (async () => {
    const raw = env.GITHUB_APP_PRIVATE_KEY
      ? env.GITHUB_APP_PRIVATE_KEY.replaceAll("\\n", "\n")
      : await readFile(env.GITHUB_APP_PRIVATE_KEY_PATH!, "utf8");
    return importPKCS8(raw, "RS256");
  })();
  return keyPromise;
}

async function appJwt() {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 30)
    .setExpirationTime(now + 9 * 60)
    .setIssuer(String(env.GITHUB_APP_ID))
    .sign(await privateKey());
}

function rateLimit(headers: Headers): GitHubRateLimit {
  const integer = (value: string | null) => value !== null && /^\d+$/.test(value) ? Number(value) : null;
  const reset = integer(headers.get("x-ratelimit-reset"));
  return {
    resource: headers.get("x-ratelimit-resource") ?? "core",
    remaining: integer(headers.get("x-ratelimit-remaining")),
    limit: integer(headers.get("x-ratelimit-limit")),
    resetAt: reset === null ? null : new Date(reset * 1000),
    retryAfterSeconds: integer(headers.get("retry-after")),
  };
}

async function providerRequest<T>(
  path: string,
  input: { method?: string; token: string; body?: unknown; expected?: number[] },
): Promise<{ data: T; rateLimit: GitHubRateLimit; status: number }> {
  const url = new URL(path, env.GITHUB_API_URL.endsWith("/") ? env.GITHUB_API_URL : `${env.GITHUB_API_URL}/`);
  const response = await fetch(url, {
    method: input.method ?? "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
      "user-agent": "folio-github-app/1",
      "x-github-api-version": "2022-11-28",
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    signal: AbortSignal.timeout(env.GITHUB_HTTP_TIMEOUT_MS),
    redirect: "error",
  }).catch((error) => {
    throw new GitHubProviderError("GITHUB_PROVIDER_UNAVAILABLE", error instanceof Error ? error.message : "GitHub request failed.", null, true);
  });
  const observed = rateLimit(response.headers);
  const expected = input.expected ?? [200];
  if (!expected.includes(response.status)) {
    const message = await response.json().then((value) => typeof value?.message === "string" ? value.message : "GitHub request failed.").catch(() => "GitHub request failed.");
    if (response.status === 401) throw new GitHubProviderError("GITHUB_UNAUTHORIZED", message, 401, false, observed);
    if (response.status === 403 && (observed.remaining === 0 || observed.retryAfterSeconds !== null)) {
      throw new GitHubProviderError("GITHUB_RATE_LIMITED", "GitHub rate limit is exhausted.", 403, true, observed);
    }
    if (response.status === 403) throw new GitHubProviderError("GITHUB_FORBIDDEN", message, 403, false, observed);
    if (response.status === 404) throw new GitHubProviderError("GITHUB_NOT_FOUND", message, 404, false, observed);
    if ([409,422].includes(response.status)) throw new GitHubProviderError("GITHUB_CONFLICT", message, response.status, false, observed);
    if (response.status >= 500) throw new GitHubProviderError("GITHUB_PROVIDER_UNAVAILABLE", message, response.status, true, observed);
    throw new GitHubProviderError("GITHUB_RESPONSE_INVALID", message, response.status, false, observed);
  }
  const data = response.status === 204 ? undefined as T : await response.json() as T;
  return { data, rateLimit: observed, status: response.status };
}

async function appRequest<T>(path: string, input?: { method?: string; body?: unknown; expected?: number[] }) {
  return providerRequest<T>(path, { token: await appJwt(), ...input });
}

async function installationToken(installationId: number): Promise<string> {
  const existing = installationTokens.get(installationId);
  if (existing && existing.expiresAt - Date.now() > 5 * 60 * 1000) return existing.token;
  const result = await appRequest<{ token: string; expires_at: string }>(`app/installations/${installationId}/access_tokens`, { method: "POST", body: {}, expected: [201] });
  const expiresAt = Date.parse(result.data.expires_at);
  if (!result.data.token || !Number.isFinite(expiresAt)) throw new GitHubProviderError("GITHUB_RESPONSE_INVALID", "GitHub installation token response is invalid.");
  installationTokens.set(installationId, { token: result.data.token, expiresAt });
  return result.data.token;
}

export async function getGitHubInstallation(installationId: number) {
  return appRequest<{
    id:number;account:{id:number;login:string;type:"User"|"Organization"|"Enterprise"};
    repository_selection:"all"|"selected";permissions:Record<string,string>;events:string[];
    suspended_at:string|null;
  }>(`app/installations/${installationId}`);
}

export async function installationGitHubRequest<T>(
  installationId: number,
  path: string,
  input?: { method?: string; body?: unknown; expected?: number[] },
) {
  return providerRequest<T>(path, { token: await installationToken(installationId), ...input });
}

export async function listGitHubInstallationRepositories(installationId: number) {
  const repositories: Array<{
    id:number;name:string;full_name:string;private:boolean;archived:boolean;default_branch:string;
    owner:{login:string};permissions?:Record<string,boolean>;updated_at?:string;
  }> = [];
  for (let page=1; page<=100; page+=1) {
    const result = await installationGitHubRequest<{ total_count:number;repositories:typeof repositories }>(installationId, `installation/repositories?per_page=100&page=${page}`);
    repositories.push(...result.data.repositories);
    if (repositories.length >= result.data.total_count || result.data.repositories.length < 100) return { repositories, rateLimit: result.rateLimit };
  }
  throw new GitHubProviderError("GITHUB_RESPONSE_INVALID", "GitHub repository pagination exceeded the supported boundary.");
}

export async function getGitHubRef(installationId:number, owner:string, repository:string, ref:string) {
  return installationGitHubRequest<{ref:string;object:{sha:string;type:string}}>(installationId, `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/ref/${encodeURIComponent(ref)}`);
}

export async function getGitHubCommit(installationId:number, owner:string, repository:string, sha:string) {
  return installationGitHubRequest<{sha:string;tree:{sha:string};parents:Array<{sha:string}>}>(installationId, `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/commits/${sha}`);
}

export async function getGitHubTree(installationId:number, owner:string, repository:string, treeSha:string, recursive=true) {
  const suffix = recursive ? "?recursive=1" : "";
  return installationGitHubRequest<{sha:string;truncated:boolean;tree:Array<{path:string;mode:string;type:"blob"|"tree"|"commit";sha:string;size?:number;url:string}>}>(installationId, `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/trees/${treeSha}${suffix}`);
}

export async function getGitHubBlob(installationId:number, owner:string, repository:string, blobSha:string) {
  return installationGitHubRequest<{sha:string;size:number;encoding:"base64";content:string}>(installationId, `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/blobs/${blobSha}`);
}

export async function createGitHubBlob(installationId:number, owner:string, repository:string, content:string) {
  return installationGitHubRequest<{sha:string;url:string}>(installationId, `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/blobs`, { method:"POST", body:{content,encoding:"utf-8"}, expected:[201] });
}

export async function createGitHubTree(installationId:number, owner:string, repository:string, baseTree:string, tree:Array<{path:string;mode:"100644";type:"blob";sha:string|null}>) {
  return installationGitHubRequest<{sha:string;url:string}>(installationId, `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/trees`, { method:"POST", body:{base_tree:baseTree,tree}, expected:[201] });
}

export async function createGitHubCommit(installationId:number, owner:string, repository:string, message:string, tree:string, parents:string[]) {
  return installationGitHubRequest<{sha:string;url:string}>(installationId, `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/commits`, { method:"POST", body:{message,tree,parents}, expected:[201] });
}

export async function createGitHubRef(installationId:number, owner:string, repository:string, ref:string, sha:string) {
  return installationGitHubRequest<{ref:string;object:{sha:string}}>(installationId, `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/refs`, { method:"POST", body:{ref:`refs/heads/${ref}`,sha}, expected:[201] });
}

export async function updateGitHubRef(installationId:number, owner:string, repository:string, ref:string, sha:string, force=false) {
  return installationGitHubRequest<{ref:string;object:{sha:string}}>(installationId, `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/git/refs/heads/${encodeURIComponent(ref)}`, { method:"PATCH", body:{sha,force}, expected:[200] });
}

export async function createGitHubPullRequest(installationId:number, owner:string, repository:string, input:{title:string;body?:string;head:string;base:string}) {
  return installationGitHubRequest<{number:number;node_id:string;html_url:string;state:string;title:string;head:{ref:string};base:{ref:string};created_at:string;updated_at:string}>(installationId, `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls`, { method:"POST", body:input, expected:[201] });
}

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { allowedWorkspaceRoots } from "./env";

const run = promisify(execFile);

export class GitError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

export function validateRepositoryPath(location: string, approvedRoots = allowedWorkspaceRoots()): string {
  const resolved = path.resolve(location);
  const roots = approvedRoots.map((root) => path.resolve(root));
  if (roots.length && !roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new GitError("This path is outside the configured repository roots.", "PATH_NOT_ALLOWED");
  }
  return resolved;
}

export async function git(location: string, args: string[], encoding: BufferEncoding | "buffer" = "utf8") {
  const safeLocation = validateRepositoryPath(location);
  try {
    const result = await run("git", ["-c", "core.hooksPath=/dev/null", "-C", safeLocation, ...args], {
      encoding: encoding === "buffer" ? "buffer" : encoding,
      timeout: 30_000,
      maxBuffer: 12 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: process.env.NODE_ENV,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    return result.stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Git command failed";
    throw new GitError(message.replace(/https?:\/\/[^\s@]+@/g, "https://[redacted]@"), "REPOSITORY_UNAVAILABLE");
  }
}

export async function validateLocalRepository(location: string, branch: string) {
  if (!/^[A-Za-z0-9._/-]+$/.test(branch) || branch.includes("..")) {
    throw new GitError("The branch name is not valid.", "INVALID_BRANCH");
  }
  await git(location, ["rev-parse", "--git-dir"]);
  const commit = String(await git(location, ["rev-parse", "--verify", `${branch}^{commit}`])).trim();
  return commit;
}

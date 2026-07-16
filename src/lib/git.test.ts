import { describe, expect, it } from "vitest";
import { GitError, validateRepositoryPath } from "./git";

describe("validateRepositoryPath", () => {
  it("normalizes repository paths", () => {
    expect(validateRepositoryPath("./fixtures/repositories", [process.cwd()])).toMatch(/fixtures\/repositories$/);
  });

  it("rejects paths outside configured roots", () => {
    expect(() => validateRepositoryPath("/tmp/outside", ["/tmp/allowed"])).toThrow(GitError);
  });
});

import { describe, expect, it } from "vitest";
import { FoundationServiceError } from "@/services/foundation/errors";
import {
  normalizeRepositoryPath,
  pathMatchesMarkdownScope,
  validateBranchName,
  validateScopeRule,
} from "@/services/github-path-policy";

describe("GitHub repository path policy", () => {
  it("normalizes repository-relative Markdown paths", () => {
    expect(normalizeRepositoryPath("./docs\\guide.md")).toBe("docs/guide.md");
    expect(() => normalizeRepositoryPath("../secret.md")).toThrow(FoundationServiceError);
    expect(() => normalizeRepositoryPath("/absolute.md")).toThrow(FoundationServiceError);
  });

  it("rejects unsafe Git branch names", () => {
    expect(validateBranchName("folio/update-docs")).toBe("folio/update-docs");
    for (const branch of ["../main", "feature..two", "bad name", "refs/heads/main", "topic.lock"]) {
      expect(() => validateBranchName(branch), branch).toThrow(FoundationServiceError);
    }
  });

  it("applies include and exclude rules only to Markdown", () => {
    const include = ["docs/**/*.md", "README.md"];
    const exclude = ["docs/private/**"];
    expect(pathMatchesMarkdownScope("docs/guide/setup.md", include, exclude)).toBe(true);
    expect(pathMatchesMarkdownScope("README.md", include, exclude)).toBe(true);
    expect(pathMatchesMarkdownScope("docs/private/plan.md", include, exclude)).toBe(false);
    expect(pathMatchesMarkdownScope("docs/guide/setup.ts", include, exclude)).toBe(false);
  });

  it("rejects control characters and parent traversal in scope rules", () => {
    expect(validateScopeRule("docs/**/*.md")).toBe("docs/**/*.md");
    expect(() => validateScopeRule("../**/*.md")).toThrow(FoundationServiceError);
    expect(() => validateScopeRule("docs/\u0000.md")).toThrow(FoundationServiceError);
  });
});

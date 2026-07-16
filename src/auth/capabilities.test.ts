import { describe, expect, it } from "vitest";
import {
  defaultProjectRoleCapabilities,
  evaluateProjectCapability,
  type ProjectCapability,
} from "./capabilities";

const capability: ProjectCapability = "repository.markdown.commit";

function baseInput() {
  return {
    capability,
    workspaceActive: true,
    projectActive: true,
    membershipActive: true,
    roleCapabilities: defaultProjectRoleCapabilities.member,
  };
}

describe("evaluateProjectCapability", () => {
  it("allows an active member capability", () => {
    expect(evaluateProjectCapability(baseInput())).toEqual({ allowed: true, reason: "allowed" });
  });

  it("lets explicit deny override role and object grants", () => {
    expect(evaluateProjectCapability({
      ...baseInput(),
      deniedGrants: new Set([capability]),
      objectCapabilities: new Set([capability]),
    })).toEqual({ allowed: false, reason: "explicitly_denied" });
  });

  it("requires an object grant when the target policy demands one", () => {
    expect(evaluateProjectCapability({
      ...baseInput(),
      requiresObjectGrant: true,
    })).toEqual({ allowed: false, reason: "object_grant_missing" });
  });

  it("intersects agent and authorizing principal capabilities", () => {
    expect(evaluateProjectCapability({
      ...baseInput(),
      agentCapabilities: new Set([capability]),
      authorizingPrincipalCapabilities: new Set<ProjectCapability>(),
    })).toEqual({ allowed: false, reason: "authorizer_capability_missing" });
  });

  it("never expands a provider denial", () => {
    expect(evaluateProjectCapability({
      ...baseInput(),
      providerAllows: false,
    })).toEqual({ allowed: false, reason: "provider_denied" });
  });
});

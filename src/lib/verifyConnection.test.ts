import { describe, it, expect } from "vitest";
import { explainSignInFailure } from "./verifyConnection";

// The messages below are what the verify workflows' failed runs actually
// reported, as GitHub's annotations carry them.
describe("explainSignInFailure", () => {
  it("names an identity with no federated credential — an old app registration", () => {
    const reason = explainSignInFailure([
      "Login failed with Error: The process '/usr/bin/az' failed with exit code 1.",
      "AADSTS70025: The client '***'(ai-chatbot-deployer) has no configured federated identity credentials. Trace ID: d6e5f9cc",
    ]);
    expect(reason).toMatch(/no federated credential/);
    expect(reason).toMatch(/clientId output of this chatbot's setup/);
  });

  it("names an identity whose credential trusts a different chatbot", () => {
    const reason = explainSignInFailure([
      "AADSTS700213: No matching federated identity record found for presented assertion subject 'repo:o/r:environment:tenant-x'.",
    ]);
    expect(reason).toMatch(/trusts a different chatbot/);
  });

  it("names an AWS role that does not trust this chatbot", () => {
    const reason = explainSignInFailure([
      "Could not assume role with OIDC: Not authorized to perform sts:AssumeRoleWithWebIdentity",
    ]);
    expect(reason).toMatch(/does not trust this chatbot's deployments/);
  });

  it("names an AWS account with no GitHub identity provider", () => {
    const reason = explainSignInFailure([
      "Could not assume role with OIDC: No OpenIDConnect provider found in your account for https://token.actions.githubusercontent.com",
    ]);
    expect(reason).toMatch(/not registered GitHub as an identity provider/);
  });

  // Anything else keeps the step name, rather than a guess.
  it("offers nothing for an error it does not know", () => {
    expect(explainSignInFailure(["Process completed with exit code 1."])).toBeNull();
    expect(explainSignInFailure([])).toBeNull();
  });
});

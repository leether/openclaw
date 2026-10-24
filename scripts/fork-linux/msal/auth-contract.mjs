// Exact synthetic request contract. No credential or token is emitted in proof.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
export const tenant = "00000000-0000-4000-8000-000000000001";
export const client = "00000000-0000-4000-8000-000000000002";
export const identityHeader = "synthetic-not-a-secret";
export const exchangeResource = "api://AzureADTokenExchange";
const scenarios = new Set([
  "azure-secret",
  "azure-certificate",
  "azure-managed",
  "teams-secret",
  "teams-certificate-provider",
  "teams-managed-user",
  "teams-managed-system",
]);
const digest = (value) => createHash("sha256").update(value).digest("hex");
export function createAuthContract(scenario) {
  assert.ok(scenarios.has(scenario));
  const mode =
    scenario === "teams-managed-system"
      ? "system-federated"
      : scenario.includes("managed")
        ? "user-assigned"
        : scenario.includes("certificate")
          ? "certificate"
          : "secret";
  let expectedScope;
  const issued = new Map();
  const proof = {
    mode,
    managedRequests: 0,
    oauthRequests: 0,
    headerChecks: 0,
    resourceChecks: 0,
    selectorChecks: 0,
    federationAssertionMatches: 0,
    exchangeTokenHashes: [],
  };
  return {
    expectScope(scope) {
      const prefix = `https://qualification.invalid/${scenario}/`;
      assert.ok(typeof scope === "string" && scope.startsWith(prefix));
      assert.ok(
        ["cache", "reject", "transport-cancel", "caller-abort"].some(
          (suffix) => scope === `${prefix}${suffix}/.default`,
        ),
      );
      expectedScope = scope;
    },
    managed(url, method, headers) {
      assert.ok(expectedScope, "caller scope required");
      assert.ok(mode === "system-federated" || mode === "user-assigned");
      assert.equal(method, "GET");
      assert.equal(url.origin, "http://169.254.0.2");
      assert.equal(url.pathname, "/msi/token");
      assert.equal(url.hash, "");
      const allowed = new Set([
        "api-version",
        "resource",
        ...(mode === "user-assigned" ? ["client_id"] : []),
      ]);
      assert.ok([...url.searchParams.keys()].every((key) => allowed.has(key)));
      for (const key of allowed) {
        assert.equal(url.searchParams.getAll(key).length, 1);
      }
      assert.equal(url.searchParams.get("api-version"), "2019-08-01");
      const resource =
        mode === "system-federated"
          ? exchangeResource
          : expectedScope.slice(0, -"/.default".length);
      assert.equal(url.searchParams.get("resource"), resource);
      assert.equal(url.searchParams.get("client_id"), mode === "user-assigned" ? client : null);
      assert.equal(new Headers(headers).get("X-IDENTITY-HEADER"), identityHeader);
      proof.managedRequests++;
      proof.headerChecks++;
      proof.resourceChecks++;
      proof.selectorChecks++;
      return resource;
    },
    issueManaged(accessToken, resource) {
      assert.ok(mode === "system-federated" || mode === "user-assigned");
      assert.ok(issued.size < 32 && typeof accessToken === "string" && accessToken.length > 0);
      if (mode === "system-federated") {
        assert.equal(resource, exchangeResource);
      }
      issued.set(accessToken, { resource, scenario });
      if (mode === "system-federated") {
        proof.exchangeTokenHashes.push(digest(accessToken));
      }
    },
    oauth(url, method, form) {
      assert.ok(expectedScope, "caller scope required");
      assert.notEqual(mode, "user-assigned");
      assert.equal(method, "POST");
      assert.equal(url.origin, "https://login.microsoftonline.com");
      assert.equal(url.pathname, `/${tenant}/oauth2/v2.0/token`);
      assert.equal(url.search, "");
      assert.equal(url.hash, "");
      for (const key of ["grant_type", "client_id", "scope"]) {
        assert.equal(form.getAll(key).length, 1);
      }
      assert.equal(form.get("grant_type"), "client_credentials");
      assert.equal(form.get("client_id"), client);
      assert.equal(form.get("scope"), expectedScope);
      const assertion = form.get("client_assertion");
      if (mode === "secret") {
        assert.equal(assertion, null);
        assert.equal(form.get("client_assertion_type"), null);
        assert.equal(form.getAll("client_secret").length, 1);
        assert.equal(form.get("client_secret"), "synthetic-not-a-credential");
      } else {
        assert.equal(form.get("client_secret"), null);
        assert.equal(form.getAll("client_assertion").length, 1);
        assert.ok(assertion);
        assert.equal(form.getAll("client_assertion_type").length, 1);
        assert.equal(
          form.get("client_assertion_type"),
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        );
        if (mode === "system-federated") {
          assert.deepEqual(issued.get(assertion), { resource: exchangeResource, scenario });
          proof.federationAssertionMatches++;
        }
      }
      proof.oauthRequests++;
      return assertion;
    },
    proof() {
      return structuredClone(proof);
    },
  };
}

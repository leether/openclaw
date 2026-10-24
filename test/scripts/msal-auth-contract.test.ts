import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import {
  client,
  createAuthContract,
  exchangeResource,
  identityHeader,
  tenant,
} from "../../scripts/fork-linux/msal/auth-contract.mjs";
import { createFakeEndpoint } from "../../scripts/fork-linux/msal/transport.mjs";

const scope = (scenario: string) => `https://qualification.invalid/${scenario}/cache/.default`;
const requestId = "10203040-5060-4070-8090-a0b0c0d0e0f0";
const otherRequestId = "10203040-5060-4070-8090-a0b0c0d0e0f1";
const oauthUrl = `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token?client-request-id=${requestId}`;
function managedUrl(scenario: string) {
  const url = new URL("http://169.254.0.2/msi/token");
  url.searchParams.set("api-version", "2019-08-01");
  url.searchParams.set(
    "resource",
    scenario === "teams-managed-system"
      ? exchangeResource
      : scope(scenario).slice(0, -"/.default".length),
  );
  if (scenario !== "teams-managed-system") {
    url.searchParams.set("client_id", client);
  }
  return url;
}
function endpoint(scenario: string) {
  const value = createFakeEndpoint({ scenario });
  value.expectScope(scope(scenario));
  return value;
}
function form(scenario: string, assertion?: string) {
  return new URLSearchParams({
    grant_type: "client_credentials",
    client_id: client,
    "client-request-id": requestId,
    scope: scope(scenario),
    ...(assertion
      ? {
          client_assertion: assertion,
          client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
        }
      : { client_secret: "synthetic-not-a-credential" }),
  }).toString();
}
const headers = { "X-IDENTITY-HEADER": identityHeader };

describe("synthetic managed identity and federation binding", () => {
  it.each(["azure-managed", "teams-managed-user"])(
    "accepts only the selected user identity for %s",
    async (scenario) => {
      const e = endpoint(scenario);
      expect(
        (await e.request(managedUrl(scenario).href, "GET", undefined, undefined, headers)).status,
      ).toBe(200);
      expect(e.authProof()).toMatchObject({
        mode: "user-assigned",
        managedRequests: 1,
        headerChecks: 1,
        resourceChecks: 1,
        selectorChecks: 1,
        oauthRequests: 0,
      });
    },
  );
  it("joins the actual issued exchange token and permits legitimate cached assertion reuse", async () => {
    const scenario = "teams-managed-system",
      e = endpoint(scenario);
    const issued = await e.request(managedUrl(scenario).href, "GET", undefined, undefined, headers);
    assert.ok(typeof issued.body.access_token === "string");
    for (let i = 0; i < 2; i++) {
      expect(
        (await e.request(oauthUrl, "POST", form(scenario, issued.body.access_token))).status,
      ).toBe(200);
    }
    expect(e.authProof()).toMatchObject({
      mode: "system-federated",
      managedRequests: 1,
      oauthRequests: 2,
      federationAssertionMatches: 2,
    });
    expect(e.authProof().exchangeTokenHashes).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
  });
  it.each([
    "selector",
    "object-selector",
    "resource-selector",
    "missing-selector",
    "header",
    "missing-header",
    "version",
    "resource",
    "duplicate-resource",
    "path",
    "port",
    "method",
  ])("rejects wrong managed %s", async (fault) => {
    const e = endpoint("azure-managed"),
      url = managedUrl("azure-managed");
    let inputHeaders: Record<string, string> = headers,
      method = "GET";
    if (fault === "selector") {
      url.searchParams.set("client_id", tenant);
    }
    if (fault === "object-selector") {
      url.searchParams.set("object_id", client);
    }
    if (fault === "resource-selector") {
      url.searchParams.set("mi_res_id", client);
    }
    if (fault === "missing-selector") {
      url.searchParams.delete("client_id");
    }
    if (fault === "header") {
      inputHeaders = { "X-IDENTITY-HEADER": "wrong" };
    }
    if (fault === "missing-header") {
      inputHeaders = {};
    }
    if (fault === "version") {
      url.searchParams.set("api-version", "2017-09-01");
    }
    if (fault === "resource") {
      url.searchParams.set("resource", exchangeResource);
    }
    if (fault === "duplicate-resource") {
      url.searchParams.append("resource", "wrong");
    }
    if (fault === "path") {
      url.pathname = "/other/token";
    }
    if (fault === "port") {
      url.port = "8080";
    }
    if (fault === "method") {
      method = "POST";
    }
    await expect(e.request(url.href, method, undefined, undefined, inputHeaders)).rejects.toThrow();
  });
  it.each(["client_id", "object_id", "mi_res_id"])(
    "rejects a system identity with %s",
    async (selector) => {
      const e = endpoint("teams-managed-system"),
        url = managedUrl("teams-managed-system");
      url.searchParams.set(selector, client);
      await expect(e.request(url.href, "GET", undefined, undefined, headers)).rejects.toThrow();
    },
  );
  it.each(["unissued", "different-endpoint", "non-exchange", "secret-fallback"])(
    "rejects federation %s",
    async (fault) => {
      const scenario = "teams-managed-system",
        e = endpoint(scenario);
      let assertion = "synthetic-unissued-token";
      if (fault === "different-endpoint") {
        const other = endpoint(scenario);
        const result = await other.request(
          managedUrl(scenario).href,
          "GET",
          undefined,
          undefined,
          headers,
        );
        assert.ok(typeof result.body.access_token === "string");
        assertion = result.body.access_token;
      }
      if (fault === "non-exchange") {
        const other = endpoint("teams-managed-user");
        const result = await other.request(
          managedUrl("teams-managed-user").href,
          "GET",
          undefined,
          undefined,
          headers,
        );
        assert.ok(typeof result.body.access_token === "string");
        assertion = result.body.access_token;
      }
      await expect(
        e.request(
          oauthUrl,
          "POST",
          form(scenario, fault === "secret-fallback" ? undefined : assertion),
        ),
      ).rejects.toThrow();
    },
  );
  it.each(["tenant", "path", "scope", "client", "assertion", "method"])(
    "rejects OAuth %s",
    async (fault) => {
      const scenario = "teams-secret",
        e = endpoint(scenario),
        url = new URL(oauthUrl),
        data = new URLSearchParams(form(scenario));
      if (fault === "tenant") {
        url.pathname = `/${client}/oauth2/v2.0/token`;
      }
      if (fault === "path") {
        url.pathname = `/${tenant}/other/token`;
      }
      if (fault === "scope") {
        data.set("scope", scope("azure-secret"));
      }
      if (fault === "client") {
        data.set("client_id", tenant);
      }
      if (fault === "assertion") {
        data.set("client_assertion", "not-a-secret-credential");
      }
      await expect(
        e.request(url.href, fault === "method" ? "GET" : "POST", data.toString()),
      ).rejects.toThrow();
    },
  );
  it("validates identity before synthetic rejection or cancellation", async () => {
    const e = endpoint("azure-managed"),
      url = managedUrl("azure-managed");
    url.searchParams.set("client_id", tenant);
    for (const action of ["reject", "cancel"]) {
      e.setAction(action);
      await expect(e.request(url.href, "GET", undefined, undefined, headers)).rejects.toThrow(
        /strictly equal/,
      );
    }
  });
});

describe("synthetic OAuth correlation binding", () => {
  it.each([
    "azure-secret",
    "azure-certificate",
    "teams-secret",
    "teams-certificate-provider",
    "teams-managed-system",
  ])("accepts the official query/form correlation shape for %s", (scenario) => {
    const contract = createAuthContract(scenario);
    contract.expectScope(scope(scenario));
    const assertion =
      scenario === "teams-managed-system"
        ? "synthetic-exchange-token"
        : scenario.includes("certificate")
          ? "synthetic-certificate-assertion"
          : undefined;
    if (scenario === "teams-managed-system") {
      contract.issueManaged(assertion, exchangeResource);
    }
    // This checks request binding only; the certificate suite and installed
    // consumer proof separately require real signatures and SDK entry points.
    expect(
      contract.oauth(new URL(oauthUrl), "POST", new URLSearchParams(form(scenario, assertion))),
    ).toBe(assertion ?? null);
    expect(contract.proof().oauthRequests).toBe(1);
  });

  it.each([
    "missing-query",
    "missing-form",
    "unknown-only",
    "unknown-extra",
    "duplicate-query-same",
    "duplicate-query-different",
    "duplicate-query-encoded-key",
    "duplicate-form-same",
    "duplicate-form-different",
    "mismatch",
    "case-mismatch",
  ])("rejects %s without recording a valid OAuth request", async (fault) => {
    const e = endpoint("azure-secret");
    const url = new URL(oauthUrl);
    const data = new URLSearchParams(form("azure-secret"));
    switch (fault) {
      case "missing-query":
        url.search = "";
        break;
      case "missing-form":
        data.delete("client-request-id");
        break;
      case "unknown-only":
        url.search = `?other-id=${requestId}`;
        break;
      case "unknown-extra":
        url.searchParams.set("other-id", requestId);
        break;
      case "duplicate-query-same":
        url.searchParams.append("client-request-id", requestId);
        break;
      case "duplicate-query-different":
        url.searchParams.append("client-request-id", otherRequestId);
        break;
      case "duplicate-query-encoded-key":
        url.search += `&client%2Drequest%2Did=${requestId}`;
        break;
      case "duplicate-form-same":
        data.append("client-request-id", requestId);
        break;
      case "duplicate-form-different":
        data.append("client-request-id", otherRequestId);
        break;
      case "mismatch":
        data.set("client-request-id", otherRequestId);
        break;
      case "case-mismatch":
        data.set("client-request-id", requestId.toUpperCase());
        break;
      default:
        throw new Error("unknown correlation fault");
    }
    await expect(e.request(url.href, "POST", data.toString())).rejects.toThrow();
    expect(e.authProof().oauthRequests).toBe(0);
    expect(e.tokenRequests).toBe(0);
  });

  it.each([
    "",
    "not-a-uuid",
    "10203040506040708090a0b0c0d0e0f0",
    "10203040-5060-4070-8090-a0b0c0d0e0fg",
    "10203040-5060-5070-8090-a0b0c0d0e0f0",
    "10203040-5060-4070-7090-a0b0c0d0e0f0",
    ` ${requestId}`,
    `${requestId} `,
    `${requestId}\n`,
    `${requestId}\r`,
    `${requestId}\r\n`,
  ])("rejects equal but invalid UUID v4 values: %j", async (invalidId) => {
    const e = endpoint("azure-secret");
    const url = new URL(oauthUrl);
    const data = new URLSearchParams(form("azure-secret"));
    url.searchParams.set("client-request-id", invalidId);
    data.set("client-request-id", invalidId);
    await expect(e.request(url.href, "POST", data.toString())).rejects.toThrow(
      "invalid synthetic OAuth request ID",
    );
    expect(e.authProof().oauthRequests).toBe(0);
    expect(e.tokenRequests).toBe(0);
  });

  it.each(["reject", "cancel"])("validates correlation before synthetic %s", async (action) => {
    const e = endpoint("azure-secret");
    const data = new URLSearchParams(form("azure-secret"));
    data.set("client-request-id", otherRequestId);
    e.setAction(action);
    await expect(e.request(oauthUrl, "POST", data.toString())).rejects.toThrow(/strictly equal/);
    expect(e.authProof().oauthRequests).toBe(0);
    expect(e.tokenRequests).toBe(0);
  });
});

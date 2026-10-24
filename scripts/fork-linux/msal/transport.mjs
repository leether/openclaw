import assert from "node:assert/strict";
import { verify, createPublicKey, constants } from "node:crypto";
import { createAuthContract, client, tenant } from "./auth-contract.mjs";
export { client, tenant };
const b64 = (x) => Buffer.from(JSON.stringify(x)).toString("base64url");
let tokenSequence = 0;
function token(aud) {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ aud, iss: `https://login.microsoftonline.com/${tenant}/v2.0`, tid: tenant, appid: client, jti: `synthetic-${++tokenSequence}`, iat: now, nbf: now, exp: now + 3600 })}.synthetic-signature`;
}
export function createFakeEndpoint({ certificate = undefined, scenario }) {
  const contract = createAuthContract(scenario);
  const events = [];
  let action = "success";
  let tokenRequests = 0;
  let signatureChecks = 0;
  let holdRelease = null;
  let entered = null;
  let heldSignal;
  const enteredPromise = new Promise((resolve) => (entered = resolve));
  async function request(url, method, body, signal, headers) {
    assert.ok(events.length < 32, "request bound");
    const u = new URL(url);
    assert.ok(
      ["login.microsoftonline.com", "169.254.0.2"].includes(u.hostname),
      "unexpected authentication host",
    );
    assert.ok(["GET", "POST"].includes(method));
    events.push({
      kind:
        u.hostname === "169.254.0.2"
          ? "managed-identity"
          : u.pathname.includes("token")
            ? "token"
            : u.pathname.includes("discovery/instance")
              ? "instance-discovery"
              : "authority-metadata",
      method,
    });
    if (u.pathname.includes("/discovery/instance"))
      return {
        status: 200,
        body: {
          tenant_discovery_endpoint: `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`,
          metadata: [
            {
              preferred_network: "login.microsoftonline.com",
              preferred_cache: "login.microsoftonline.com",
              aliases: [
                "login.microsoftonline.com",
                "login.windows.net",
                "login.microsoft.com",
                "sts.windows.net",
              ],
            },
          ],
        },
      };
    if (u.pathname.includes(".well-known"))
      return {
        status: 200,
        body: {
          authorization_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
          token_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
          issuer: `https://login.microsoftonline.com/${tenant}/v2.0`,
          jwks_uri: `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
          end_session_endpoint: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/logout`,
        },
      };
    assert.ok(
      u.pathname.endsWith("/token") || u.hostname === "169.254.0.2",
      "unknown auth operation",
    );
    const managed = u.hostname === "169.254.0.2";
    const form = new URLSearchParams(typeof body === "string" ? body : String(body ?? ""));
    const resource = managed ? contract.managed(u, method, headers) : null;
    const assertion = managed ? null : contract.oauth(u, method, form);
    tokenRequests++;
    // Deliberately keep the transport Promise outstanding until explicit release;
    // observing an aborted signal alone is not an actual source terminal state.
    if (action === "hold") {
      heldSignal = signal;
      await new Promise((resolve) => {
        holdRelease = resolve;
        entered();
      });
    }
    if (action === "cancel")
      throw new DOMException("Synthetic transport cancellation", "AbortError");
    if (action === "reject")
      return {
        status: 400,
        body: {
          error: "invalid_client",
          error_description: "Synthetic credential rejection",
          error_codes: [7000215],
          timestamp: new Date().toISOString(),
          trace_id: tenant,
          correlation_id: client,
        },
      };
    if (managed) {
      const accessToken = token(resource);
      contract.issueManaged(accessToken, resource);
      return {
        status: 200,
        body: {
          access_token: accessToken,
          expires_on: String(Math.floor(Date.now() / 1000) + 3600),
          token_type: "Bearer",
          resource,
        },
      };
    }
    if (certificate && assertion) {
      const parts = assertion.split(".");
      assert.equal(parts.length, 3);
      const algorithm = JSON.parse(Buffer.from(parts[0], "base64url")).alg;
      assert.ok(["RS256", "PS256"].includes(algorithm));
      const claims = JSON.parse(Buffer.from(parts[1], "base64url"));
      assert.equal(claims.iss, client);
      assert.equal(claims.sub, client);
      assert.equal(claims.aud, u.href);
      assert.ok(claims.exp > Math.floor(Date.now() / 1000));
      const publicKey = createPublicKey(certificate);
      const verificationKey =
        algorithm === "PS256"
          ? { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }
          : publicKey;
      assert.ok(
        verify(
          "RSA-SHA256",
          Buffer.from(`${parts[0]}.${parts[1]}`),
          verificationKey,
          Buffer.from(parts[2], "base64url"),
        ),
        "actual MSAL certificate assertion signature",
      );
      signatureChecks++;
    }
    return {
      status: 200,
      body: {
        token_type: "Bearer",
        expires_in: 3600,
        ext_expires_in: 3600,
        scope: form.get("scope"),
        access_token: token(form.get("scope")),
      },
    };
  }
  return {
    events,
    request,
    expectScope: contract.expectScope,
    authProof: contract.proof,
    setAction: (v) => {
      assert.ok(["success", "reject", "cancel", "hold"].includes(v));
      action = v;
    },
    get tokenRequests() {
      return tokenRequests;
    },
    get signatureChecks() {
      return signatureChecks;
    },
    entered: enteredPromise,
    release() {
      assert.ok(holdRelease);
      action = "success";
      const release = holdRelease;
      holdRelease = null;
      release();
    },
    get outstanding() {
      return holdRelease !== null;
    },
    get heldSignal() {
      return { present: heldSignal !== undefined, aborted: heldSignal?.aborted === true };
    },
  };
}

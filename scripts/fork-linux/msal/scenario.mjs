// All credentials/tokens are synthetic. No actual socket or listener is allowed.
import assert from "node:assert/strict";
import dns from "node:dns";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { createRequire, syncBuiltinESMExports } from "node:module";
import net from "node:net";
import path from "node:path";
import tls from "node:tls";
import { inspect, sha } from "./identity.mjs";
import { createFakeEndpoint, client, tenant } from "./transport.mjs";
const [root, scenario] = process.argv.slice(2);
const report = {
  schema: "msal-consumer-scenario-v1",
  passed: false,
  scenario,
  noOutbound: false,
  serverListenCalls: 0,
  socketAttempts: 0,
  cases: [],
};
try {
  for (const key of Object.keys(process.env))
    if (
      /^(AZURE_|MSI_|IDENTITY_|IMDS_|CLIENT_|TENANT_|CLOUD$|MANAGED_IDENTITY|SERVICE_URL)/.test(key)
    )
      delete process.env[key];
  const deny = () => {
    report.socketAttempts++;
    throw Error("real network operation prohibited");
  };
  net.Socket.prototype.connect = deny;
  tls.connect = deny;
  dns.lookup = deny;
  http.request = deny;
  https.request = deny;
  net.Server.prototype.listen = function () {
    report.serverListenCalls++;
    throw Error("server start prohibited");
  };
  syncBuiltinESMExports();
  process.env.IDENTITY_ENDPOINT = "http://169.254.0.2/msi/token";
  process.env.IDENTITY_HEADER = "synthetic-not-a-secret";
  const rows = inspect(root);
  const req = createRequire(path.join(root, "package.json"));
  const certificate = fs.readFileSync(
    new URL("./fixture/synthetic-cert.pem", import.meta.url),
    "utf8",
  );
  const key = fs.readFileSync(new URL("./fixture/synthetic-key.pem", import.meta.url), "utf8");
  const endpoint = createFakeEndpoint({
    scenario,
    certificate: scenario.includes("certificate") ? certificate : undefined,
  });
  globalThis.fetch = async (input, options = {}) => {
    assert.equal(typeof input, "string");
    const response = await endpoint.request(
      input,
      options.method ?? "GET",
      options.body,
      options.signal,
      options.headers,
    );
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
  const azure = req("@azure/identity");
  const pipeline = createRequire(path.join(rows[0].parentRoot, "package.json"))(
    "@azure/core-rest-pipeline",
  );
  const httpClient = {
    async sendRequest(request) {
      const response = await endpoint.request(
        request.url,
        request.method,
        request.body,
        request.abortSignal,
        request.headers.toJSON(),
      );
      return {
        request,
        status: response.status,
        headers: pipeline.createHttpHeaders({ "content-type": "application/json" }),
        bodyAsText: JSON.stringify(response.body),
      };
    },
  };
  const opts = { httpClient, retryOptions: { maxRetries: 0 }, disableInstanceDiscovery: true };
  const { App } = req("@microsoft/teams.apps");
  const logger = {
    child() {
      return this;
    },
    debug() {},
    info() {},
    warn() {},
    error() {},
    trace() {},
    log() {},
  };
  let invoke;
  const supportsCallerSignal = scenario.startsWith("azure-");
  if (scenario === "azure-secret") {
    const cred = new azure.ClientSecretCredential(
      tenant,
      client,
      "synthetic-not-a-credential",
      opts,
    );
    invoke = (scope, signal) => cred.getToken(scope, { abortSignal: signal });
  } else if (scenario === "azure-certificate") {
    const cred = new azure.ClientCertificateCredential(
      tenant,
      client,
      { certificate: `${certificate}\n${key}` },
      opts,
    );
    invoke = (scope, signal) => cred.getToken(scope, { abortSignal: signal });
  } else if (scenario === "azure-managed") {
    const cred = new azure.ManagedIdentityCredential({ clientId: client, ...opts });
    invoke = (scope, signal) => cred.getToken(scope, { abortSignal: signal });
  } else {
    const options = { clientId: client, tenantId: tenant, clientSecret: "", logger };
    if (scenario === "teams-secret") options.clientSecret = "synthetic-not-a-credential";
    else if (scenario === "teams-certificate-provider") {
      const cred = new azure.ClientCertificateCredential(
        tenant,
        client,
        { certificate: `${certificate}\n${key}` },
        opts,
      );
      options.token = async (scope) => (await cred.getToken(scope)).token;
    } else if (scenario === "teams-managed-user") options.managedIdentityClientId = client;
    else if (scenario === "teams-managed-system") options.managedIdentityClientId = "system";
    else throw Error("unknown scenario");
    const app = new App(options);
    invoke = (scope) => app.tokenProvider.getAppToken(scope, tenant);
  }
  const consume = invoke;
  invoke = (scope, signal) => {
    endpoint.expectScope(scope);
    return consume(scope, signal);
  };
  const tokenText = (result) =>
    typeof result?.token === "string" ? result.token : result?.toString();
  const scope = (suffix) => `https://qualification.invalid/${scenario}/${suffix}/.default`;
  const first = await invoke(scope("cache"));
  assert.ok(tokenText(first)?.split(".").length === 3);
  const count = endpoint.tokenRequests;
  assert.ok(count > 0);
  const second = await invoke(scope("cache"));
  assert.equal(tokenText(second), tokenText(first));
  assert.equal(endpoint.tokenRequests, count);
  report.cases.push({
    name: "real-consumer-acquire-and-cache",
    passed: true,
    tokenRequests: count,
  });
  endpoint.setAction("reject");
  await assert.rejects(invoke(scope("reject")));
  endpoint.setAction("success");
  const afterRejection = endpoint.tokenRequests;
  assert.ok(tokenText(await invoke(scope("reject"))));
  assert.ok(endpoint.tokenRequests > afterRejection);
  report.cases.push({ name: "rejection-not-cached", passed: true });
  endpoint.setAction("cancel");
  await assert.rejects(invoke(scope("transport-cancel")));
  endpoint.setAction("success");
  const afterCancel = endpoint.tokenRequests;
  assert.ok(tokenText(await invoke(scope("transport-cancel"))));
  assert.ok(endpoint.tokenRequests > afterCancel);
  report.cases.push({ name: "transport-abort-rejects-without-success-cache", passed: true });
  endpoint.setAction("hold");
  let settled = false;
  const controller = new AbortController();
  let outcome;
  const pending = invoke(scope("caller-abort"), controller.signal).then(
    (value) => {
      settled = true;
      outcome = { kind: "fulfilled", hasToken: !!tokenText(value) };
    },
    (error) => {
      settled = true;
      outcome = { kind: "rejected", errorName: error?.name ?? "Error" };
    },
  );
  await endpoint.entered;
  controller.abort();
  await new Promise((resolve) => queueMicrotask(resolve));
  const beforeRelease = {
    requestPromiseSettled: settled,
    actualEndpointStillOpen: endpoint.outstanding,
    transportSignal: endpoint.heldSignal,
  };
  assert.equal(beforeRelease.actualEndpointStillOpen, true);
  endpoint.release();
  await pending;
  assert.equal(endpoint.outstanding, false);
  report.callerCancellation = {
    optionAccepted: supportsCallerSignal,
    beforeRelease,
    outcome,
    sourceReleasedAndJoined: true,
    claim: supportsCallerSignal
      ? "option-present-propagation-not-guaranteed"
      : "public-API-has-no-AbortSignal-parameter",
  };
  if (scenario.includes("certificate"))
    assert.ok(endpoint.signatureChecks > 0, "real MSAL signing must execute");
  assert.equal(report.socketAttempts, 0);
  assert.equal(report.serverListenCalls, 0);
  report.events = endpoint.events;
  report.authContract = endpoint.authProof();
  report.signatureChecks = endpoint.signatureChecks;
  report.tokenRequests = endpoint.tokenRequests;
  report.noOutbound = true;
  report.passed = true;
} catch (error) {
  report.failure = {
    name: error?.name ?? "Error",
    messageSha256: sha(Buffer.from(String(error?.message ?? error))),
  };
}
console.log(JSON.stringify(report));
process.exitCode = report.passed ? 0 : 1;

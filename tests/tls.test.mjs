import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cliCommand, cliPrefix } from "./cli-helper.mjs";
import { errorDetails, EngageClient } from "../dist/http.js";
import { saveSession } from "../dist/session.js";

const run = promisify(execFile);


test("CLI trusts OS-installed CAs and still rejects an untrusted local certificate", { skip: process.platform !== "linux" }, async t => {
  const dir = await mkdtemp(join(tmpdir(), "engagectl-tls-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const key = join(dir, "server.key");
  const cert = join(dir, "server.crt");
  const emptyStore = join(dir, "empty-store");
  await mkdir(emptyStore);
  const emptyBundle = join(emptyStore, "empty.pem");
  await writeFile(emptyBundle, "");
  await run("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1", "-addext", "basicConstraints=critical,CA:TRUE"]);
  let requests = 0;
  const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (_request, response) => {
    requests++;
    response.writeHead(401);
    response.end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const origin = `https://127.0.0.1:${server.address().port}`;
  const env = { ...process.env, SSL_CERT_FILE: cert, SSL_CERT_DIR: emptyStore, ENGAGECTL_SESSION_FILE: join(dir, "session.json") };
  delete env.ENGAGECTL_API_URL;
  delete env.NODE_EXTRA_CA_CERTS;
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;

  await assert.rejects(run(cliCommand, [...cliPrefix, "login", "--api-url", origin, "--no-browser"], { env }), error => {
    const details = JSON.parse(error.stderr);
    assert.equal(error.code, 1);
    assert.equal(error.stdout, "");
    assert.equal(details.status, 401);
    assert.equal(details.error, "Engage HTTP 401");
    assert.match(details.hint, /endpoint must be public/);
    assert.match(details.hint, /restart the local backend/);
    return true;
  });
  assert.equal(requests, 1, "The trusted HTTPS request must reach the backend");

  await assert.rejects(run(cliCommand, [...cliPrefix, "login", "--api-url", origin, "--no-browser"], {
    env: { ...env, SSL_CERT_FILE: emptyBundle },
  }), error => {
    const details = JSON.parse(error.stderr);
    assert.equal(error.code, 1);
    assert.match(details.error, /Request failed for https:\/\/127\.0\.0\.1:/);
    assert.equal(details.code, "DEPTH_ZERO_SELF_SIGNED_CERT");
    assert.match(details.hint, /issuing CA/);
    return true;
  });
  assert.equal(requests, 1, "An untrusted certificate must fail before an HTTP request is sent");
});

test("authenticated transport errors preserve the cause without exposing cookies or query parameters", async t => {
  const dir = await mkdtemp(join(tmpdir(), "engagectl-network-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "session.json");
  const token = "t".repeat(43);
  await saveSession({ apiUrl: "https://api.engage.example", cookieName: "engage_session", token,
    workspaceId: "workspace", userId: "user", email: "user@example.com", expiresAt: new Date(Date.now() + 60_000).toISOString() }, path);
  const client = new EngageClient(path, async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" }) });
  });
  await assert.rejects(client.json("/api/backoffice/projects?private=do-not-print"), error => {
    const details = errorDetails(error);
    assert.equal(details.code, "ECONNREFUSED");
    assert.match(details.hint, /backend and gateway/);
    assert.equal(JSON.stringify(details).includes(token), false);
    assert.equal(JSON.stringify(details).includes("do-not-print"), false);
    return true;
  });
});

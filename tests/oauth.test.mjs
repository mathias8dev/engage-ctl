import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { cliCommand, cliPrefix } from "./cli-helper.mjs";
import { saveSession, loadSession } from "../dist/session.js";
import { EngageClient } from "../dist/http.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
const run = promisify(execFile);
const json = (res, data, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
async function fixture(t, handler) {
  const dir = await mkdtemp(join(tmpdir(), "engagectl-oauth-"));
  const path = join(dir, "session.json"); const calls = [];
  const server = createServer(async (req, res) => {
    try {
      const body = []; for await (const chunk of req) body.push(chunk);
      const form = new URLSearchParams(Buffer.concat(body).toString());
      calls.push(req.url); await handler(req, res, form, path);
    } catch (error) { t.diagnostic(error); json(res, {}, 500); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const session = { schemaVersion: 2, issuer: origin, apiUrl: origin, resource: `${origin}/engage/console`, clientId: "engagectl",
    accessToken: "access.old.token", refreshToken: "refresh-old", accessTokenExpiresAt: 1,
    scopes: "openid email offline_access engage.console", userId: "user", workspaceId: "workspace", email: "user@example.com" };
  await saveSession(session, path);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("ENGAGECTL_")));
  return { path, session, calls, origin, env: { ...env, ENGAGECTL_SESSION_FILE: path } };
}
const rotated = { access_token: "access.new.token", refresh_token: "refresh-new", token_type: "Bearer", expires_in: 3600, scope: "openid email offline_access engage.console" };

test("CLI refreshes an expired access token and persists its replacement before contacting Engage", async t => {
  const f = await fixture(t, async (req, res, form, path) => {
    if (req.url === "/oauth2/token") {
      assert.equal(form.get("grant_type"), "refresh_token"); assert.equal(form.get("client_id"), "engagectl");
      assert.equal(form.get("refresh_token"), "refresh-old"); assert.equal(form.get("client_secret"), null);
      json(res, rotated);
    } else {
      const stored = await loadSession(path); assert.equal(stored.refreshToken, "refresh-new");
      assert.equal(req.headers.authorization, "Bearer access.new.token"); assert.equal(req.headers.cookie, undefined);
      assert.equal(req.headers["x-engage-workspace"], "workspace"); json(res, { id: "user" });
    }
  });
  const { stdout } = await run(cliCommand, [...cliPrefix, "status"], { env: f.env });
  assert.equal(JSON.parse(stdout).issuer, f.origin); assert.equal(stdout.includes("access.new.token"), false);
  assert.equal(stdout.includes("refresh-new"), false);
  assert.deepEqual(f.calls, ["/oauth2/token", "/api/backoffice/auth/me"]);
});

test("refresh failure is not retried, calls no API and cannot expose a credential-bearing error body", async t => {
  const f = await fixture(t, (_req, res) => json(res, { error: "invalid_grant", error_description: "refresh-old access.old.token" }, 400));
  await assert.rejects(run(cliCommand, [...cliPrefix, "status"], { env: f.env }), error => {
    assert.match(error.stderr, /invalid_grant/); assert.equal(error.stderr.includes("refresh-old"), false); return true;
  });
  assert.deepEqual(f.calls, ["/oauth2/token"]); assert.equal((await loadSession(f.path)).refreshToken, "refresh-old");
});

test("a lock or mismatched issuer blocks refresh before any network request", async t => {
  const f = await fixture(t, (_req, res) => json(res, rotated));
  await writeFile(f.path + ".lock", '{"pid":1}', { mode: 0o600 });
  await assert.rejects(run(cliCommand, [...cliPrefix, "status"], { env: f.env }), error => /Session is in use/.test(error.stderr));
  await rm(f.path + ".lock");
  await assert.rejects(run(cliCommand, [...cliPrefix, "status"], { env: { ...f.env, ENGAGECTL_ISSUER: "https://foreign.example" } }), error => /issuer does not match/.test(error.stderr));
  assert.equal(f.calls.length, 0);
});

test("MCP automatically rotates once and continues using the persisted token across tool calls", async t => {
  const f = await fixture(t, (req, res) => json(res, req.url === "/oauth2/token" ? rotated : { id: "user" }));
  const transport = new StdioClientTransport({ command: cliCommand, args: [...cliPrefix, "mcp"], env: f.env, stderr: "pipe" });
  const client = new Client({ name: "engage-refresh-test", version: "1.0.0" }); t.after(() => client.close());
  await client.connect(transport);
  for (let i = 0; i < 2; i++) {
    const result = await client.callTool({ name: "engage_status", arguments: {} });
    assert.equal(result.isError, undefined); assert.equal(JSON.stringify(result).includes("refresh-new"), false);
  }
  assert.equal(f.calls.filter(path => path === "/oauth2/token").length, 1);
});

test("logout preserves the rotating grant on revocation failure and removes it after success", async t => {
  let fail = true;
  const f = await fixture(t, (_req, res, form) => { assert.equal(form.get("token"), "refresh-old"); json(res, {}, fail ? 503 : 200); });
  await assert.rejects(run(cliCommand, [...cliPrefix, "logout"], { env: f.env }));
  assert.equal((await loadSession(f.path)).refreshToken, "refresh-old");
  fail = false; await run(cliCommand, [...cliPrefix, "logout"], { env: f.env });
  await assert.rejects(readFile(f.path), { code: "ENOENT" }); assert.deepEqual(f.calls, ["/oauth2/revoke", "/oauth2/revoke"]);
});

test("wrong explicit issuer is rejected before opening Identity and writes are never retried", async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url.endsWith("/config")) json(res, { issuer: f.origin, clientId: "engagectl", resource: `${f.origin}/engage/console` });
    else if (req.url === "/oauth2/token") json(res, rotated);
    else json(res, { code: "permission_denied" }, 403);
  });
  await assert.rejects(run(cliCommand, [...cliPrefix, "login", "--api-url", f.origin, "--issuer", "https://foreign.example", "--no-browser"], { env: f.env }), error => /Issuer differs/.test(error.stderr));
  const response = await new EngageClient(f.path).request("/api/backoffice/projects", { method: "POST", body: "{}" });
  assert.equal(response.status, 403); assert.equal(f.calls.filter(path => path === "/api/backoffice/projects").length, 1);
});

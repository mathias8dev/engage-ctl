import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, chmod, lstat, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cliCommand, cliPrefix } from "./cli-helper.mjs";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { saveSession, loadSession, apiOrigin } from "../dist/session.js";
import { EngageClient } from "../dist/http.js";
import { OperationCatalog, execute } from "../dist/operations.js";

const run = promisify(execFile);

const token = "t".repeat(43);
const spec = {
  openapi: "3.1.0", paths: {
    "/api/backoffice/projects": {
      get: { operationId: "listProjects", responses: { 200: { description: "Projects" } } },
      post: { operationId: "createProject", requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateProject" } } } } },
    },
    "/api/backoffice/projects/{projectId}": {
      get: { operationId: "getProject", parameters: [{ in: "path", name: "projectId", required: true }], responses: {} },
      patch: { operationId: "updateProject", parameters: [{ in: "path", name: "projectId", required: true }], responses: {} },
    },
    "/api/backoffice/environments/{environmentId}/profiles:search": {
      post: { operationId: "searchProfiles", parameters: [{ in: "path", name: "environmentId", required: true }, { in: "query", name: "page", required: true }, { in: "query", name: "tags" }], responses: {} },
    },
    "/api/media/uploads/{assetId}": { put: { operationId: "upload", parameters: [{ in: "path", name: "assetId", required: true }, { in: "header", name: "X-Engage-Media-Upload-Token", required: true }], responses: {} } },
    "/api/backoffice/download": { get: { operationId: "download", responses: {} } },
    "/api/backoffice/auth/native/exchange": { post: { operationId: "forbiddenExchange", responses: {} } },
    "/api/v1/send": { post: { operationId: "serverSend", responses: {} } },
  }, components: { schemas: { CreateProject: { type: "object", required: ["name"], properties: { name: { type: "string" }, status: { $ref: "#/components/schemas/Status" } } }, Status: { type: "string", enum: ["ACTIVE", "ARCHIVED"] } } },
};

async function fixture(t, { multipleWorkspaces = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "engagectl-test-"));
  await chmod(dir, 0o700);
  const path = join(dir, "session.json");
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    calls.push({ method: request.method, url: request.url, headers: request.headers, body });
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/backoffice/auth/native/config") {
      response.end(JSON.stringify({ issuer: origin, clientId: "engagectl", authorizationUri: `${origin}/oauth2/authorize`, cookieName: "engage_session" })); return;
    }
    if (request.url === "/api/backoffice/auth/native/exchange") {
      const exchange = JSON.parse(body);
      assert.equal(createHash("sha256").update(exchange.codeVerifier).digest("base64url"), expectedChallenge);
      assert.equal(exchange.nonce, expectedNonce);
      if (multipleWorkspaces && !exchange.workspaceId) {
        response.end(JSON.stringify({ status: "WORKSPACE_SELECTION_REQUIRED", ticket: "p".repeat(43),
          workspaces: [{ id: "workspace-a", name: "Workspace A" }, { id: "workspace-b", name: "Workspace B" }] })); return;
      }
      response.end(JSON.stringify({ status: "AUTHENTICATED", token, workspaceId: exchange.workspaceId ?? "workspace-a", userId: "user-a", email: "user@example.com", expiresAt })); return;
    }
    if (request.headers.cookie !== `engage_session=${token}`) { response.statusCode = 401; response.end('{"code":"authentication_required"}'); return; }
    if (request.url === "/api/backoffice/openapi") { response.end(JSON.stringify(spec)); return; }
    if (request.url === "/api/backoffice/auth/me") { response.end('{"id":"user-a","email":"user@example.com"}'); return; }
    if (request.url === "/api/backoffice/auth/logout") {
      response.statusCode = 204; response.setHeader("Set-Cookie", "engage_session=; Max-Age=0"); response.end(); return;
    }
    if (request.url === "/api/backoffice/download") { response.setHeader("Content-Type", "application/octet-stream"); response.end(Buffer.from([0, 1, 2, 255])); return; }
    if (request.url === "/api/backoffice/projects/denied") { response.statusCode = 403; response.end('{"code":"permission_denied","message":"Denied"}'); return; }
    if (request.url === "/api/backoffice/projects/redirect") { response.statusCode = 302; response.setHeader("Location", "/api/backoffice/auth/me"); response.end(); return; }
    if (request.url === "/api/backoffice/projects" && request.method === "POST") { response.statusCode = 201; response.end(body); return; }
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  let expectedChallenge;
  let expectedNonce;
  const session = { apiUrl: origin, token, cookieName: "engage_session", workspaceId: "workspace-a", userId: "user-a", email: "user@example.com", expiresAt };
  await saveSession(session, path);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const env = { ...process.env, ENGAGECTL_SESSION_FILE: path, ENGAGECTL_API_URL: origin };
  return { dir, path, calls, origin, session, env, client: new EngageClient(path), challenge: (value, nonce) => { expectedChallenge = value; expectedNonce = nonce; } };
}

test("discovers all operation families, resolves enum schemas, validates paths and sends exact scoped requests", async t => {
  const f = await fixture(t);
  const catalog = await OperationCatalog.load(f.client);
  assert.equal(catalog.search("", 0, 2).operations.length, 2);
  assert.equal(catalog.search("", 0, 2).total, 7);
  assert.throws(() => catalog.operation("serverSend"), /Unknown operation/);
  assert.throws(() => catalog.operation("forbiddenExchange"), /Unknown operation/);
  const schema = catalog.schema("createProject");
  assert.deepEqual(schema.components.schemas.Status.enum, ["ACTIVE", "ARCHIVED"]);
  assert.throws(() => catalog.prepare({ operationId: "getProject" }), /Missing path/);
  assert.throws(() => catalog.prepare({ operationId: "getProject", path: { projectId: ".." } }), /Invalid path/);
  assert.throws(() => catalog.prepare({ operationId: "searchProfiles", path: { environmentId: "env" } }), /Required query/);
  assert.throws(() => catalog.prepare({ operationId: "listProjects", headers: { Authorization: "evil" } }), /not an operation/);
  assert.throws(() => catalog.prepare({ operationId: "listProjects", query: { unknown: "value" } }), /Unknown query/);
  const result = await execute(f.client, catalog, { operationId: "createProject", body: { name: "Agent project" } });
  assert.equal(result.status, 201);
  assert.equal(result.body.name, "Agent project");
  assert.equal(f.calls.at(-1).headers["x-engage-client"], "console");
  await assert.rejects(execute(f.client, catalog, { operationId: "getProject", path: { projectId: "denied" } }), error => error.status === 403 && error.body.code === "permission_denied");
  await assert.rejects(execute(f.client, catalog, { operationId: "getProject", path: { projectId: "redirect" } }));
  assert.equal(f.calls.filter(call => call.url === "/api/backoffice/auth/me").length, 0);
  const binary = await execute(f.client, catalog, { operationId: "download" });
  assert.deepEqual(Buffer.from(binary.bodyBase64, "base64"), Buffer.from([0, 1, 2, 255]));
  await execute(f.client, catalog, { operationId: "upload", path: { assetId: "asset" },
    headers: { "X-Engage-Media-Upload-Token": "capability" }, contentType: "image/png", rawBodyBase64: "AAEC/w==" });
  assert.equal(f.calls.at(-1).headers["content-type"], "image/png");
  assert.equal(f.calls.at(-1).headers["x-engage-media-upload-token"], "capability");
  assert.deepEqual(f.calls.at(-1).body, Buffer.from([0, 1, 2, 255]));
});

test("CLI dry-run performs no write, downloads bytes, preserves API failures and revokes logout", async t => {
  const f = await fixture(t);
  const input = join(f.dir, "request.json");
  await import("node:fs/promises").then(fs => fs.writeFile(input, JSON.stringify({ body: { name: "Draft" } })));
  const dry = await run(cliCommand, [...cliPrefix, "execute", "createProject", "--input", input, "--dry-run"], { env: f.env });
  assert.equal(JSON.parse(dry.stdout).workspaceId, "workspace-a");
  assert.equal(f.calls.filter(call => call.method === "POST").length, 0);
  const output = join(f.dir, "download.bin");
  await run(cliCommand, [...cliPrefix, "execute", "download", "--output", output], { env: f.env });
  assert.deepEqual(await readFile(output), Buffer.from([0, 1, 2, 255]));
  if (process.platform !== "win32") assert.equal((await lstat(output)).mode & 0o777, 0o600);
  await assert.rejects(run(cliCommand, [...cliPrefix, "execute", "download", "--output", output], { env: f.env }));
  await run(cliCommand, [...cliPrefix, "logout"], { env: f.env });
  await assert.rejects(readFile(f.path), /ENOENT/);
  assert.equal(f.calls.at(-1).url, "/api/backoffice/auth/logout");
});

test("session storage is private, refuses symlinks and rejects untrusted API origins", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t);
  assert.equal((await lstat(f.path)).mode & 0o777, 0o600);
  await assert.rejects(saveSession({ ...f.session, token: "x".repeat(43) }, f.path), /EEXIST/);
  assert.equal((await loadSession(f.path)).token, token);
  await chmod(f.path, 0o644);
  await assert.rejects(loadSession(f.path), /private/);
  await chmod(f.path, 0o600);
  const link = join(f.dir, "link.json");
  await symlink(f.path, link);
  await assert.rejects(loadSession(link));
  for (const url of ["http://example.com", "https://user:pass@example.com", "https://example.com/api", "https://example.com?token=x"]) assert.throws(() => apiOrigin(url));
});

test("a running client refuses a changed account or workspace before sending a request", async t => {
  const f = await fixture(t);
  await f.client.session();
  await saveSession({ ...f.session, workspaceId: "workspace-b" }, f.path, true);
  await assert.rejects(f.client.json("/api/backoffice/projects"), /workspace or instance changed/);
  assert.equal(f.calls.length, 0);
});

test("browser PKCE login validates callback state and stores only a private session", async t => {
  const f = await fixture(t);
  await rm(f.path);
  const child = spawn(cliCommand, [...cliPrefix, "login", "--api-url", f.origin, "--no-browser"], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  let stdout = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  const authorization = await new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", chunk => {
      stderr += chunk;
      const url = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/oauth2\/authorize\?[^\s]+/);
      if (url) resolve(new URL(url[0]));
    });
    child.on("exit", code => reject(new Error(`Login exited before authorization: ${code}: ${stderr}`)));
  });
  assert.equal(authorization.searchParams.get("client_id"), "engagectl");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.get("max_age"), "0");
  f.challenge(authorization.searchParams.get("code_challenge"), authorization.searchParams.get("nonce"));
  const callback = new URL(authorization.searchParams.get("redirect_uri"));
  callback.search = new URLSearchParams({ state: "wrong", code: "c".repeat(43) });
  assert.equal((await fetch(callback)).status, 400);
  callback.search = new URLSearchParams({ state: "é".repeat(43), code: "c".repeat(43) });
  assert.equal((await fetch(callback)).status, 400);
  callback.search = new URLSearchParams({ state: authorization.searchParams.get("state"), code: "c".repeat(43), iss: "https://wrong-issuer.example" });
  assert.equal((await fetch(callback)).status, 400);
  callback.search = new URLSearchParams({ state: authorization.searchParams.get("state"), code: "c".repeat(43), iss: f.origin });
  assert.equal((await fetch(callback)).status, 200);
  assert.equal(await new Promise(resolve => child.on("exit", resolve)), 0);
  assert.equal((await loadSession(f.path)).workspaceId, "workspace-a");
  assert.equal(stdout.includes(token), false);
  assert.equal(JSON.parse(stdout).email, "user@example.com");
});

test("noninteractive native login requires an explicit workspace and never stores a pending ticket", async t => {
  for (const workspaceId of [undefined, "workspace-b"]) {
    const f = await fixture(t, { multipleWorkspaces: true });
    await rm(f.path);
    const child = spawn(cliCommand, [...cliPrefix, "login", "--api-url", f.origin, "--no-browser",
      ...(workspaceId ? ["--workspace", workspaceId] : [])], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => child.kill());
    const exited = new Promise(resolve => child.on("exit", resolve));
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    const authorization = await new Promise((resolve, reject) => {
      child.stderr.on("data", chunk => {
        stderr += chunk;
        const match = stderr.match(/http:\/\/127\.0\.0\.1:\d+\/oauth2\/authorize\?[^\s]+/);
        if (match) resolve(new URL(match[0]));
      });
      child.on("exit", code => reject(new Error(`Login exited early: ${code}: ${stderr}`)));
    });
    f.challenge(authorization.searchParams.get("code_challenge"), authorization.searchParams.get("nonce"));
    const callback = new URL(authorization.searchParams.get("redirect_uri"));
    callback.search = new URLSearchParams({ state: authorization.searchParams.get("state"), iss: f.origin, code: "c".repeat(43) });
    assert.equal((await fetch(callback)).status, 200);
    assert.equal(await exited, workspaceId ? 0 : 1);
    if (workspaceId) {
      assert.equal((await loadSession(f.path)).workspaceId, workspaceId);
      assert.equal(JSON.parse(stdout).clientId, "engagectl");
    } else {
      assert.match(stderr, /Select a workspace with login --workspace ID/);
      await assert.rejects(readFile(f.path), /ENOENT/);
    }
  }
});

test("official MCP client discovers and invokes stdio tools with explicit permission errors", async t => {
  const f = await fixture(t);
  const transport = new StdioClientTransport({ command: cliCommand, args: [...cliPrefix, "mcp"], env: f.env, stderr: "pipe" });
  const client = new Client({ name: "engage-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(transport);
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 4);
  const write = tools.tools.find(tool => tool.name === "engage_execute");
  assert.equal(write.annotations.destructiveHint, true);
  const status = await client.callTool({ name: "engage_status", arguments: {} });
  assert.equal(JSON.parse(status.content[0].text).workspaceId, "workspace-a");
  assert.equal(JSON.stringify(status).includes(token), false);
  const denied = await client.callTool({ name: "engage_execute", arguments: { operationId: "getProject", path: { projectId: "denied" } } });
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content[0].text).error.code, "permission_denied");
});

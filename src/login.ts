import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { apiOrigin, saveSession, sessionPath } from "./session.js";
import { ApiError, publicJson } from "./http.js";

const configSchema = z.object({ issuer: z.string().url(), clientId: z.literal("engagectl"), authorizationUri: z.string().url(), cookieName: z.string() });
enum LoginStatus { AUTHENTICATED = "AUTHENTICATED", WORKSPACE_SELECTION_REQUIRED = "WORKSPACE_SELECTION_REQUIRED" }
const sessionResultSchema = z.object({ status: z.literal(LoginStatus.AUTHENTICATED), token: z.string(), workspaceId: z.string(), userId: z.string(), email: z.string(), expiresAt: z.iso.datetime() });
const resultSchema = z.discriminatedUnion("status", [sessionResultSchema, z.object({ status: z.literal(LoginStatus.WORKSPACE_SELECTION_REQUIRED),
  ticket: z.string(), workspaces: z.array(z.object({ id: z.string(), name: z.string() })).min(1) })]);

export async function login(origin: string, noBrowser = false, path = sessionPath(), workspaceId?: string): Promise<unknown> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) throw new Error("A session already exists; logout first or choose another ENGAGECTL_SESSION_FILE");
  const apiUrl = apiOrigin(origin);
  const config = configSchema.parse(await publicJson(apiUrl, "/api/backoffice/auth/native/config").catch(error => {
    if (error instanceof ApiError && error.status === 401) {
      throw new ApiError(error.status, error.body,
        "The CLI configuration endpoint must be public. Check that this backend runs the current native authorization routes; restart the local backend after updating its code, and check gateway access rules if needed.");
    }
    throw error;
  }));
  const issuer = new URL(config.issuer);
  const authorization = new URL(config.authorizationUri);
  if (issuer.username || issuer.password || issuer.search || issuer.hash || authorization.username || authorization.password ||
      authorization.origin !== issuer.origin || (issuer.protocol !== "https:" &&
        !(issuer.protocol === "http:" && ["localhost", "127.0.0.1"].includes(issuer.hostname)))) throw new Error("Invalid Identity issuer or authorization endpoint");
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
  let redirectUri = "";
  let resolveCode!: (value: string) => void;
  let rejectCode!: (error: Error) => void;
  const received = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
  const server = createServer((request, response) => {
    const callback = new URL(request.url ?? "/", redirectUri);
    const actualState = callback.searchParams.get("state") ?? "";
    const stateBytes = Buffer.from(actualState);
    const validState = stateBytes.length === state.length && timingSafeEqual(Buffer.from(state), stateBytes);
    if (request.method !== "GET" || request.headers.host !== new URL(redirectUri).host ||
        callback.pathname !== "/oauth2/callback" || !validState ||
        callback.searchParams.getAll("state").length !== 1 || callback.searchParams.getAll("iss").length !== 1 ||
        callback.searchParams.get("iss") !== config.issuer ||
        (callback.searchParams.has("error") ? (callback.searchParams.getAll("error").length !== 1 || callback.searchParams.has("code")) :
          (callback.searchParams.getAll("code").length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(callback.searchParams.get("code") ?? "")))) {
      response.writeHead(400, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      response.end("Invalid Engage CLI callback.");
      return;
    }
    response.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'" });
    response.end("Engage CLI authorization received. You can close this tab.");
    if (callback.searchParams.has("error")) rejectCode(new Error("Identity authorization was denied or could not be completed"));
    else resolveCode(callback.searchParams.get("code")!);
  });
  const cancellation = new AbortController();
  const cancel = (error: Error) => { cancellation.abort(error); rejectCode(error); };
  const timeout = setTimeout(() => cancel(new Error("Login timed out after five minutes")), 300_000);
  const abort = () => cancel(new Error("Login cancelled"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Cannot bind loopback callback");
    redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`;
    authorization.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: redirectUri,
      response_type: "code", scope: "openid email", state, nonce, code_challenge: codeChallenge,
      code_challenge_method: "S256", max_age: "0" }).toString();
    process.stderr.write(`Open this URL to authorize Engage CLI for ${apiUrl}:\n${authorization}\n`);
    if (!noBrowser) {
      const [command, ...args] = process.platform === "darwin" ? ["open", authorization.href] :
        process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", authorization.href] : ["xdg-open", authorization.href];
      const browser = spawn(command!, args, { stdio: "ignore", detached: true });
      browser.on("error", () => process.stderr.write("Open the authorization URL above in your browser.\n"));
      browser.unref();
    }
    const code = await received;
    let result = resultSchema.parse(await publicJson(apiUrl, "/api/backoffice/auth/native/exchange", { code, redirectUri, codeVerifier: verifier, nonce,
      ...(workspaceId ? { workspaceId } : {}) }));
    if (result.status === LoginStatus.WORKSPACE_SELECTION_REQUIRED) {
      if (!process.stdin.isTTY) throw new Error(`Select a workspace with login --workspace ID: ${result.workspaces.map(w => `${w.name} (${w.id})`).join(", ")}`);
      for (const [index, workspace] of result.workspaces.entries()) process.stderr.write(`${index + 1}. ${workspace.name} (${workspace.id})\n`);
      const prompt = createInterface({ input: process.stdin, output: process.stderr });
      let selected: string;
      try {
        const index = Number(await prompt.question("Workspace number: ", { signal: cancellation.signal })) - 1;
        if (!Number.isInteger(index) || !result.workspaces[index]) throw new Error("Invalid workspace selection");
        selected = result.workspaces[index]!.id;
      } finally { prompt.close(); }
      result = sessionResultSchema.parse(await publicJson(apiUrl, "/api/backoffice/auth/native/workspace", { ticket: result.ticket, workspaceId: selected }));
    }
    cancellation.signal.throwIfAborted();
    const { status: _status, ...session } = result;
    await saveSession({ apiUrl, cookieName: config.cookieName, ...session }, path);
    return { apiUrl, issuer: config.issuer, clientId: config.clientId, workspaceId: result.workspaceId, email: result.email, expiresAt: result.expiresAt };
  } finally {
    clearTimeout(timeout);
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
    server.closeAllConnections();
    server.close();
  }
}

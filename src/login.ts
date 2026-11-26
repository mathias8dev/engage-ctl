import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { CLIENT_PATTERN, SCOPES, TOKEN_PATTERN, integer, origin, sessionPath } from "./config.js";
import { ApiError, oauthPost, publicJson, jsonResponse } from "./http.js";
import { z } from "zod";
import { createInterface } from "node:readline/promises";
import { saveSession, tokenSession, withSessionLock } from "./session.js";

export interface LoginOptions {
  issuer?: string;
  apiUrl: string;
  workspaceId?: string;
  callbackPort?: string;
  timeout?: string;
  noBrowser?: boolean;
}

export async function login(options: LoginOptions): Promise<unknown> {
  const apiUrl = origin(options.apiUrl, "API URL");
  const config = z.object({ issuer: z.string(), clientId: z.literal("engagectl"), resource: z.string() }).parse(
    await publicJson(apiUrl, "/api/backoffice/auth/native/config").catch(error => {
      if (error instanceof ApiError && error.status === 401) throw new ApiError(401, error.body,
        "The CLI configuration endpoint must be public. Check the backend native OAuth routes and gateway; restart the local backend after updating its code.");
      throw error;
    }));
  const issuer = origin(options.issuer ?? config.issuer, "Issuer");
  if (issuer !== config.issuer) throw new Error("Issuer differs from this Engage API's configured Identity issuer");
  const resource = config.resource;
  if (resource !== `${issuer}/engage/console`) throw new Error("Unexpected Engage OAuth resource");
  const clientId = config.clientId;
  if (!CLIENT_PATTERN.test(clientId)) throw new Error("Invalid public client ID");
  const port = options.callbackPort ? integer(options.callbackPort, "Callback port", 1024, 65535) : 0;
  const timeoutMs = integer(options.timeout ?? "300", "Login timeout", 1, 900) * 1000;
  return withSessionLock(async () => {
    const existing = await lstat(sessionPath()).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
    if (existing) throw new Error("A session already exists; logout first or choose another ENGAGECTL_SESSION_FILE");
    const state = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const received = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; });
    // Binding can fail before the main await; cancellation must still be observed.
    void received.catch(() => {});
    let redirectUri = "";
    let accepted = false;
    const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, (request, response) => {
      const reply = (status: number, text: string) => {
        response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'", "Referrer-Policy": "no-referrer" });
        response.end(text);
      };
      if (!redirectUri || !request.url?.startsWith("/") || request.url.startsWith("//")) { reply(400, "Invalid Engage callback."); return; }
      const callback = new URL(request.url, redirectUri);
      const actualState = Buffer.from(callback.searchParams.get("state") ?? "");
      const validState = actualState.length === state.length && timingSafeEqual(actualState, Buffer.from(state));
      if (request.method !== "GET" || request.headers.host !== new URL(redirectUri).host ||
          callback.pathname !== "/oauth2/callback" || !validState ||
          callback.searchParams.getAll("state").length !== 1 || callback.searchParams.getAll("iss").length !== 1 ||
          callback.searchParams.get("iss") !== issuer) {
        reply(400, "Invalid Engage callback."); return;
      }
      if (accepted) { reply(409, "Engage callback already received."); return; }
      const errors = callback.searchParams.getAll("error");
      const codes = callback.searchParams.getAll("code");
      if (errors.length === 1 && codes.length === 0 && /^[a-z_]{1,64}$/.test(errors[0]!)) {
        accepted = true;
        reply(400, "Identity authorization was refused.");
        rejectCode(new Error(`Identity authorization refused (${errors[0]})`));
        return;
      }
      if (errors.length || codes.length !== 1 || !codes[0] || !TOKEN_PATTERN.test(codes[0])) {
        reply(400, "Invalid Engage callback."); return;
      }
      accepted = true;
      reply(200, "Engage CLI authorization received. You can close this tab.");
      resolveCode(codes[0]);
    });
    const cancellation = new AbortController();
    const abort = () => { cancellation.abort(); rejectCode(new Error("Identity login cancelled")); };
    const timeout = setTimeout(() => { cancellation.abort(); rejectCode(new Error("Identity login timed out")); }, timeoutMs);
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Cannot bind the loopback callback listener");
      redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`;
      const authorization = new URL("/oauth2/authorize", issuer);
      authorization.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri,
        response_type: "code", scope: SCOPES, resource, nonce, max_age: "0",
        code_challenge: challenge, code_challenge_method: "S256", state }).toString();
      process.stderr.write(`Open this URL to authorize Engage CLI:\n${authorization.href}\n`);
      if (!options.noBrowser) {
        const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
        const arguments_ = process.platform === "win32" ? ["url.dll,FileProtocolHandler", authorization.href] : [authorization.href];
        const browser = spawn(command, arguments_, { stdio: "ignore", detached: true });
        browser.on("error", () => process.stderr.write("Open the authorization URL above manually.\n"));
        browser.unref();
      }
      const code = await received;
      const token = await oauthPost(issuer, "/oauth2/token", { grant_type: "authorization_code", client_id: clientId,
        code, redirect_uri: redirectUri, code_verifier: verifier });
      const pending = tokenSession(token, { issuer, apiUrl, clientId, resource, userId: null, workspaceId: null, email: null });
      // Persist the rotating grant before the first product API call, even if workspace selection fails.
      await saveSession(pending);
      const response = await fetch(new URL("/api/backoffice/auth/native/workspaces", apiUrl), {
        redirect: "error", signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(30_000)]),
        headers: { Authorization: `Bearer ${pending.accessToken}`, Accept: "application/json" },
      });
      const admission = z.object({ userId: z.string().min(1), email: z.string(),
        workspaces: z.array(z.object({ id: z.string().min(1), name: z.string() })).min(1) }).parse(await jsonResponse(response));
      let workspaceId = options.workspaceId ?? (admission.workspaces.length === 1 ? admission.workspaces[0]!.id : undefined);
      if (!workspaceId) {
        if (!process.stdin.isTTY) throw new Error(`Select a workspace with login --workspace ID: ${admission.workspaces.map(w => `${w.name} (${w.id})`).join(", ")}. Run engagectl logout before retrying.`);
        for (const [index, workspace] of admission.workspaces.entries()) process.stderr.write(`${index + 1}. ${workspace.name} (${workspace.id})\n`);
        const prompt = createInterface({ input: process.stdin, output: process.stderr });
        try {
          const index = Number(await prompt.question("Workspace number: ", { signal: cancellation.signal })) - 1;
          workspaceId = admission.workspaces[index]?.id;
        } finally { prompt.close(); }
      }
      if (!workspaceId || !admission.workspaces.some(w => w.id === workspaceId)) throw new Error("Invalid workspace selection; run engagectl logout before retrying");
      cancellation.signal.throwIfAborted();
      await saveSession({ ...pending, userId: admission.userId, email: admission.email, workspaceId }, sessionPath(), true);
      return { apiUrl, issuer, clientId, userId: admission.userId, workspaceId, email: admission.email,
        accessTokenExpiresAt: pending.accessTokenExpiresAt };
    } finally {
      clearTimeout(timeout);
      process.removeListener("SIGINT", abort);
      process.removeListener("SIGTERM", abort);
      server.closeAllConnections();
      server.close();
    }
  });
}

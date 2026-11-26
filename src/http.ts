import { VERSION } from "./version.js";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { apiOrigin } from "./config.js";
import { currentSession, type AuthenticatedSession } from "./session.js";

// Include locally installed gateway/enterprise CAs while retaining bundled and extra CAs.
// This runs before the CLI or MCP makes its first connection; TLS verification stays enabled.
setDefaultCACertificates([...getCACertificates("default"), ...getCACertificates("system")]);

export class ApiError extends Error {
  constructor(readonly status: number, readonly body: unknown, readonly hint?: string) {
    super(`Engage HTTP ${status}${body ? `: ${typeof body === "string" ? body : JSON.stringify(body)}` : ""}`);
  }
}

export function errorDetails(error: unknown): { error: unknown; status?: number; code?: string; hint?: string } {
  if (error instanceof ApiError) {
    return { status: error.status, error: error.body || error.message, ...(error.hint ? { hint: error.hint } : {}) };
  }
  let cause: unknown = error;
  let code: string | undefined;
  for (let depth = 0; depth < 6 && cause instanceof Error; depth++) {
    const candidate = (cause as NodeJS.ErrnoException).code;
    if (typeof candidate === "string" && candidate) { code = candidate; break; }
    cause = cause.cause;
  }
  const hints: Record<string, string> = {
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: "Install the issuing CA in your system trust store, or provide its PEM file with NODE_EXTRA_CA_CERTS.",
    UNABLE_TO_GET_ISSUER_CERT_LOCALLY: "Install the issuing CA in your system trust store, or provide its PEM file with NODE_EXTRA_CA_CERTS.",
    SELF_SIGNED_CERT_IN_CHAIN: "Install the issuing CA in your system trust store, or provide its PEM file with NODE_EXTRA_CA_CERTS.",
    DEPTH_ZERO_SELF_SIGNED_CERT: "Install the issuing CA in your system trust store, or provide its PEM file with NODE_EXTRA_CA_CERTS.",
    CERT_HAS_EXPIRED: "The server certificate has expired; renew it before retrying.",
    ERR_TLS_CERT_ALTNAME_INVALID: "The server certificate does not match the requested hostname; check the API URL and gateway certificate.",
    ECONNREFUSED: "Check the API URL and that the backend and gateway are running.",
    ENOTFOUND: "The API hostname could not be resolved; check DNS and the API URL.",
    EAI_AGAIN: "DNS resolution failed temporarily; check the resolver before retrying.",
  };
  const hint = code ? hints[code] : undefined;
  return { error: error instanceof Error ? error.message : "Engage operation failed", ...(code ? { code } : {}), ...(hint ? { hint } : {}) };
}

async function fetchResponse(url: URL, init: RequestInit, fetcher: typeof fetch = fetch): Promise<Response> {
  try { return await fetcher(url, init); }
  catch (error) {
    if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) throw error;
    // Do not include query parameters, headers, or request bodies in transport diagnostics.
    throw new Error(`Request failed for ${url.origin}${url.pathname}`, { cause: error });
  }
}

// Bounded text/JSON results protect the agent's context and memory. Binary downloads use --output.
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export async function readBounded(response: Response, limit = MAX_RESPONSE_BYTES): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error(`Response exceeds ${limit} bytes; use pagination or a file download`);
      parts.push(value);
    }
  } finally { await reader.cancel(); }
  return Buffer.concat(parts);
}

export async function jsonResponse(response: Response): Promise<unknown> {
  const text = new TextDecoder().decode(await readBounded(response));
  let result: unknown = text;
  if (text && response.headers.get("content-type")?.includes("json")) result = JSON.parse(text);
  if (!response.ok) throw new ApiError(response.status, result);
  return result;
}

export async function publicJson(origin: string, path: string, body?: unknown): Promise<unknown> {
  const response = await fetchResponse(new URL(path, apiOrigin(origin)), {
    method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { "Accept": "application/json", "User-Agent": `engagectl/${VERSION}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return jsonResponse(response);
}

enum OAuthErrorCode {
  INVALID_REQUEST = "invalid_request", INVALID_CLIENT = "invalid_client", INVALID_GRANT = "invalid_grant",
  INVALID_SCOPE = "invalid_scope", UNAUTHORIZED_CLIENT = "unauthorized_client", ACCESS_DENIED = "access_denied",
  SERVER_ERROR = "server_error", TEMPORARILY_UNAVAILABLE = "temporarily_unavailable",
}

export async function oauthPost(issuer: string, path: string, values: Record<string, string>): Promise<unknown> {
  const response = await fetchResponse(new URL(path, issuer), {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": `engagectl/${VERSION}` },
    body: new URLSearchParams(values),
  });
  const bytes = await readBounded(response, 64 * 1024);
  if (!response.ok) {
    let code: string | undefined;
    try {
      const value = JSON.parse(new TextDecoder().decode(bytes));
      if (Object.values(OAuthErrorCode).includes(value?.error)) code = value.error;
    } catch { /* Never include a credential-bearing OAuth error body. */ }
    throw new ApiError(response.status, code ?? "Identity OAuth request rejected",
      code === OAuthErrorCode.INVALID_GRANT ? "The refresh grant expired or was revoked; run engagectl logout then engagectl login." : undefined);
  }
  if (!bytes.length) return undefined;
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("Identity returned invalid OAuth JSON"); }
}

export class EngageClient {
  private binding?: string;
  constructor(private readonly sessionFile?: string, private readonly fetcher: typeof fetch = fetch) {}

  async session(): Promise<AuthenticatedSession> {
    return currentSession(this.sessionFile, session => {
      const binding = JSON.stringify([session.apiUrl, session.issuer, session.clientId, session.resource, session.userId, session.workspaceId]);
      if (this.binding && this.binding !== binding) {
        throw new Error("Engage account, issuer, workspace or instance changed; restart this client and inspect engage_status before acting");
      }
      this.binding ??= binding;
    });
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const session = await this.session();
    const url = new URL(path, session.apiUrl);
    if (url.origin !== session.apiUrl || !url.pathname.startsWith("/api/")) throw new Error("Request must target this Engage API");
    const headers = new Headers(init.headers);
    headers.delete("Cookie");
    headers.set("Authorization", `Bearer ${session.accessToken}`);
    headers.set("X-Engage-Workspace", session.workspaceId);
    headers.set("X-Engage-Client", "console");
    headers.set("User-Agent", `engagectl/${VERSION}`);
    headers.set("Accept", "application/json");
    return fetchResponse(url, {
      ...init, headers, redirect: "error", signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    }, this.fetcher);
  }

  async json(path: string, init: RequestInit = {}): Promise<unknown> {
    return jsonResponse(await this.request(path, init));
  }
}

import { z } from "zod";
import { EngageClient, ApiError, jsonResponse, readBounded } from "./http.js";

export enum HttpMethod { GET = "get", POST = "post", PUT = "put", PATCH = "patch", DELETE = "delete", HEAD = "head", OPTIONS = "options" }
export enum ParameterLocation { PATH = "path", QUERY = "query", HEADER = "header", COOKIE = "cookie" }
enum ParameterStyle { MATRIX = "matrix", LABEL = "label", FORM = "form", SIMPLE = "simple", SPACE_DELIMITED = "spaceDelimited", PIPE_DELIMITED = "pipeDelimited", DEEP_OBJECT = "deepObject" }
const parameterSchema = z.object({
  name: z.string(), in: z.enum(ParameterLocation), required: z.boolean().optional(),
  schema: z.record(z.string(), z.unknown()).optional(), style: z.enum(ParameterStyle).optional(), explode: z.boolean().optional(),
}).passthrough();
const operationSchema = z.object({
  operationId: z.string(), summary: z.string().optional(), description: z.string().optional(),
  tags: z.array(z.string()).optional(), parameters: z.array(parameterSchema).optional(),
  requestBody: z.object({ required: z.boolean().optional(), content: z.record(z.string(), z.unknown()) }).optional(),
}).passthrough();
const documentSchema = z.object({
  openapi: z.string(), paths: z.record(z.string(), z.record(z.string(), z.unknown())),
  components: z.record(z.string(), z.unknown()).optional(),
});
export type Operation = z.infer<typeof operationSchema> & { path: string; method: HttpMethod };
export const executionSchema = z.object({
  operationId: z.string().min(1),
  path: z.record(z.string(), z.string()).optional(),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean()]))])).optional(),
  headers: z.record(z.string(), z.string()).optional(), body: z.unknown().optional(),
  contentType: z.string().optional(),
  rawBodyBase64: z.string().max(96 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).optional(),
}).strict();
export type Execution = z.infer<typeof executionSchema>;
const credentialHeaders = new Set(["authorization", "cookie", "host", "x-engage-client", "set-cookie"]);

export class OperationCatalog {
  private constructor(readonly operations: Operation[], private readonly document: z.infer<typeof documentSchema>) {}

  static async load(client: EngageClient): Promise<OperationCatalog> {
    // The schema has no user data but may be larger than ordinary paginated API responses.
    const response = await client.request("/api/backoffice/openapi");
    if (!response.ok) await jsonResponse(response);
    const document = documentSchema.parse(JSON.parse(new TextDecoder().decode(await readBounded(response, 16 * 1024 * 1024))));
    const operations: Operation[] = [];
    const ids = new Set<string>();
    for (const [path, item] of Object.entries(document.paths)) {
      if (!path.startsWith("/api/backoffice/") && !path.startsWith("/api/media/uploads/")) continue;
      if (path.startsWith("/api/backoffice/auth/native/") || path.startsWith("/api/backoffice/openapi")) continue;
      for (const method of Object.values(HttpMethod)) {
        if (!item[method]) continue;
        const operation = operationSchema.parse(item[method]);
        if (ids.has(operation.operationId)) throw new Error(`Duplicate OpenAPI operation ID: ${operation.operationId}`);
        ids.add(operation.operationId);
        operations.push({ ...operation, method, path });
      }
    }
    if (!operations.length) throw new Error("Engage returned an empty console operation catalog");
    return new OperationCatalog(operations.sort((a, b) => a.operationId.localeCompare(b.operationId)), document);
  }

  search(query = "", offset = 0, limit = 25): unknown {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Use offset >= 0 and limit 1..100");
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    const results = this.operations.filter(operation => {
      const haystack = [operation.operationId, operation.path, operation.summary, operation.description, ...(operation.tags ?? [])].join(" ").toLowerCase();
      return words.every(word => haystack.includes(word));
    });
    return { total: results.length, offset, limit, operations: results.slice(offset, offset + limit).map(({ operationId, method, path, summary, tags }) => ({ operationId, method: method.toUpperCase(), path, summary, tags })) };
  }

  operation(id: string): Operation {
    const operation = this.operations.find(item => item.operationId === id);
    if (!operation) throw new Error(`Unknown operation ${id}; use engagectl operations to discover current operations`);
    return operation;
  }

  schema(id: string): unknown {
    const operation = this.operation(id);
    const components: Record<string, Record<string, unknown>> = {};
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== "object") return;
      const object = value as Record<string, unknown>;
      if (typeof object.$ref === "string") {
        const match = /^#\/components\/([^/]+)\/([^/]+)$/.exec(object.$ref);
        if (!match) throw new Error(`Unsupported schema reference ${object.$ref}`);
        const group = match[1]!;
        const name = match[2]!;
        const section = this.document.components?.[group] as Record<string, unknown> | undefined;
        const referenced = section?.[name];
        if (!referenced) throw new Error(`Missing schema reference ${object.$ref}`);
        const included = components[group] ??= {};
        if (!(name in included)) { included[name] = referenced; visit(referenced); }
      }
      Object.values(object).forEach(visit);
    };
    visit(operation);
    return { ...operation, components };
  }

  prepare(value: Execution): { method: string; path: string; headers: Record<string, string>; body?: string | Uint8Array } {
    const input = executionSchema.parse(value);
    const operation = this.operation(input.operationId);
    let path = operation.path;
    const parameters = operation.parameters ?? [];
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(input.path ?? {})) {
      if (!parameters.some(p => p.in === ParameterLocation.PATH && p.name === name) || [".", ".."].includes(value)) throw new Error(`Invalid path parameter ${name}`);
      path = path.replaceAll(`{${name}}`, encodeURIComponent(value));
    }
    if (/\{[^}]+\}/.test(path)) throw new Error(`Missing path parameters for ${path}`);
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(input.query ?? {})) {
      const parameter = parameters.find(p => p.in === ParameterLocation.QUERY && p.name === name);
      if (!parameter) throw new Error(`Unknown query parameter ${name}`);
      if (Array.isArray(value)) {
        if (parameter.explode === false) query.append(name, value.join(","));
        else for (const item of value) query.append(name, String(item));
      } else query.append(name, String(value));
    }
    for (const [name, value] of Object.entries(input.headers ?? {})) {
      if (credentialHeaders.has(name.toLowerCase()) || !parameters.some(p => p.in === ParameterLocation.HEADER && p.name.toLowerCase() === name.toLowerCase())) throw new Error(`Header ${name} is not an operation parameter`);
      headers[name.toLowerCase()] = value;
    }
    for (const parameter of parameters.filter(p => p.required)) {
      if (parameter.in === ParameterLocation.QUERY && !query.has(parameter.name)) throw new Error(`Required query parameter ${parameter.name}`);
      if (parameter.in === ParameterLocation.HEADER && !Object.keys(headers).some(name => name.toLowerCase() === parameter.name.toLowerCase())) throw new Error(`Required header ${parameter.name}`);
    }
    if (query.size) path += `?${query}`;
    if (input.body !== undefined && input.rawBodyBase64 !== undefined) throw new Error("Choose body or rawBodyBase64");
    const body = input.rawBodyBase64 === undefined ? (input.body === undefined ? undefined : JSON.stringify(input.body)) : Buffer.from(input.rawBodyBase64, "base64");
    if (operation.requestBody?.required && body === undefined) throw new Error("This operation requires a request body");
    if (body !== undefined) headers["content-type"] = input.contentType ?? headers["content-type"] ?? (input.rawBodyBase64 === undefined ? "application/json" : "application/octet-stream");
    return { method: operation.method.toUpperCase(), path, headers, ...(body === undefined ? {} : { body }) };
  }
}

export async function execute(client: EngageClient, catalog: OperationCatalog, input: Execution, signal?: AbortSignal): Promise<unknown> {
  const prepared = catalog.prepare(input);
  const response = await client.request(prepared.path, {
    method: prepared.method, headers: prepared.headers,
    ...(prepared.body === undefined ? {} : { body: prepared.body as BodyInit }),
    ...(signal ? { signal } : {}),
  });
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json") || contentType.startsWith("text/") || !response.ok || response.status === 204) {
    return { status: response.status, contentType, body: await jsonResponse(response) };
  }
  const bytes = await readBounded(response);
  if (!response.ok) throw new ApiError(response.status, "Binary error response");
  return { status: response.status, contentType, bodyBase64: Buffer.from(bytes).toString("base64") };
}

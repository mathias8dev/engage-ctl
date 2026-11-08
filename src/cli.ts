#!/usr/bin/env node
import { VERSION } from "./version.js";
import { parseArgs } from "node:util";
import { open, rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { EngageClient, errorDetails, jsonResponse } from "./http.js";
import { login } from "./login.js";
import { removeSession } from "./session.js";
import { OperationCatalog, executionSchema, execute } from "./operations.js";

async function readInput(path: string): Promise<string> {
  if (path !== "-") {
    const handle = await open(path, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error("JSON input must be a regular file up to 2 MiB");
      return await handle.readFile("utf8");
    } finally { await handle.close(); }
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error("JSON input exceeds 2 MiB");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

enum Command { LOGIN = "login", STATUS = "status", LOGOUT = "logout", OPERATIONS = "operations", SCHEMA = "schema", EXECUTE = "execute", MCP = "mcp", HELP = "help" }
const help = `Usage:
  engagectl login --api-url https://api.engage.example [--no-browser] [--workspace ID]
  engagectl status
  engagectl logout
  engagectl operations [keywords] [--offset 0] [--limit 25]
  engagectl schema OPERATION_ID
  engagectl execute OPERATION_ID --input request.json [--dry-run] [--output download.bin]
  engagectl execute OPERATION_ID --input - [--body-file upload.bin --content-type image/png]
  engagectl mcp
  engagectl --version

Input JSON: {"path":{},"query":{},"headers":{},"body":{}}
Use schema to inspect the current operation contract. --dry-run prepares the request without executing it.
--output creates a new private file; existing files are never overwritten.
ENGAGECTL_API_URL supplies the login API origin. ENGAGECTL_SESSION_FILE selects an independent session.
All commands emit JSON to stdout; diagnostics and browser login URLs go to stderr.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { "api-url": { type: "string" }, workspace: { type: "string" }, "no-browser": { type: "boolean" }, input: { type: "string" },
      "dry-run": { type: "boolean" }, output: { type: "string" }, "body-file": { type: "string" },
      "content-type": { type: "string" }, offset: { type: "string" }, limit: { type: "string" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } },
  });
  if (values.version) { process.stdout.write(`${VERSION}\n`); return; }
  const [command, ...args] = positionals;
  const print = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  const client = new EngageClient();
  if (values.help || !command || command === Command.HELP) { process.stdout.write(help); return; }
  if (!Object.values(Command).includes(command as Command)) throw new Error(`Unknown command ${command}; use engagectl --help`);
  if (![Command.OPERATIONS, Command.SCHEMA, Command.EXECUTE].includes(command as Command) && args.length) throw new Error("Unexpected positional arguments");
  const allowedOptions: Record<Command, string[]> = {
    [Command.LOGIN]: ["api-url", "no-browser", "workspace"], [Command.STATUS]: [], [Command.LOGOUT]: [],
    [Command.OPERATIONS]: ["offset", "limit"], [Command.SCHEMA]: [],
    [Command.EXECUTE]: ["input", "dry-run", "output", "body-file", "content-type"], [Command.MCP]: [], [Command.HELP]: [],
  };
  for (const option of Object.keys(values)) {
    if (!allowedOptions[command as Command].includes(option)) throw new Error(`--${option} is not valid for ${command}`);
  }
  switch (command) {
    case Command.LOGIN: {
      const origin = values["api-url"] ?? process.env.ENGAGECTL_API_URL;
      if (!origin) throw new Error("Specify --api-url or ENGAGECTL_API_URL");
      print(await login(origin, values["no-browser"], undefined, values.workspace)); return;
    }
    case Command.MCP: {
      const { startMcp } = await import("./mcp.js"); startMcp(); return;
    }
    case Command.STATUS: {
      const session = await client.session();
      print({ apiUrl: session.apiUrl, workspaceId: session.workspaceId, expiresAt: session.expiresAt, account: await client.json("/api/backoffice/auth/me") }); return;
    }
    case Command.LOGOUT: {
      // Remote failure keeps the local session available for a retry. 401 means it is already invalid.
      const response = await client.request("/api/backoffice/auth/logout", { method: "POST" });
      if (response.status !== 401) await jsonResponse(response);
      await removeSession(); print({ loggedOut: true }); return;
    }
  }
  const catalog = await OperationCatalog.load(client);
  if (command === Command.OPERATIONS) { print(catalog.search(args.join(" "), Number(values.offset ?? 0), Number(values.limit ?? 25))); return; }
  if (args.length !== 1) throw new Error("Specify one operation ID");
  const operationId = args[0]!;
  if (command === Command.SCHEMA) { print(catalog.schema(operationId)); return; }
  const raw: unknown = values.input ? JSON.parse(await readInput(values.input)) : {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || "operationId" in raw) throw new Error("Input must be an object without operationId");
  const input = executionSchema.parse({ ...raw, operationId });
  if (values["body-file"]) {
    if (input.body !== undefined || input.rawBodyBase64 !== undefined) throw new Error("--body-file cannot be combined with an input body");
    const handle = await open(values["body-file"], "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) throw new Error("Body file must be a regular file up to 64 MiB");
      input.rawBodyBase64 = (await handle.readFile()).toString("base64");
    } finally { await handle.close(); }
  }
  if (values["content-type"]) input.contentType = values["content-type"];
  const prepared = catalog.prepare(input);
  if (values["dry-run"]) {
    const session = await client.session();
    print({ apiUrl: session.apiUrl, workspaceId: session.workspaceId, ...prepared,
      ...(typeof prepared.body === "object" ? { body: { bytes: prepared.body.byteLength } } : {}) }); return;
  }
  if (!values.output) { print(await execute(client, catalog, input)); return; }
  const file = await open(values.output, "wx", 0o600);
  let status: number;
  let contentType: string | null;
  try {
    const response = await client.request(prepared.path, { method: prepared.method, headers: prepared.headers,
      ...(prepared.body === undefined ? {} : { body: prepared.body as BodyInit }) });
    if (!response.ok) await jsonResponse(response);
    status = response.status;
    contentType = response.headers.get("content-type");
    if (response.body) await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), file.createWriteStream({ autoClose: false }));
    await file.sync();
  } catch (error) { await rm(values.output, { force: true }); throw error; }
  finally { await file.close(); }
  print({ status, output: values.output, contentType });
}

main().catch(error => {
  process.stderr.write(`${JSON.stringify(errorDetails(error))}\n`);
  process.exitCode = 1;
});

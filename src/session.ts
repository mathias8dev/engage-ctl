import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { z } from "zod";

const sessionSchema = z.object({
  apiUrl: z.string(), cookieName: z.string().regex(/^[A-Za-z0-9_-]+$/),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), workspaceId: z.string().min(1),
  userId: z.string().min(1), email: z.string(), expiresAt: z.iso.datetime(),
}).strict();
export type Session = z.infer<typeof sessionSchema>;

export function apiOrigin(value: string): string {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))) {
    throw new Error("API URL must be an HTTPS origin (HTTP is allowed only on localhost or 127.0.0.1)");
  }
  return url.origin;
}

export function sessionPath(): string {
  return process.env.ENGAGECTL_SESSION_FILE ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "lookandtry", "engagectl", "session.json");
}

function requirePrivate(stat: Stats, kind: "file" | "directory"): void {
  if ((kind === "file" ? !stat.isFile() : !stat.isDirectory()) || stat.isSymbolicLink() ||
      (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
    throw new Error(`Session ${kind} must belong to you, be private, and not be a symlink`);
  }
}

export async function loadSession(path = sessionPath()): Promise<Session> {
  await requireDirectory(path);
  requirePrivate(await lstat(path), "file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    requirePrivate(await handle.stat(), "file");
    const session = sessionSchema.parse(JSON.parse(await handle.readFile("utf8")));
    apiOrigin(session.apiUrl);
    if (process.env.ENGAGECTL_API_URL && apiOrigin(process.env.ENGAGECTL_API_URL) !== session.apiUrl) {
      throw new Error("ENGAGECTL_API_URL differs from the stored session; select the matching ENGAGECTL_SESSION_FILE");
    }
    return session;
  } finally { await handle.close(); }
}

async function requireDirectory(path: string): Promise<void> {
  requirePrivate(await lstat(dirname(path)), "directory");
}

export async function saveSession(value: Session, path = sessionPath(), replace = false): Promise<void> {
  const session = sessionSchema.parse(value);
  apiOrigin(session.apiUrl);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await requireDirectory(path);
  const temporary = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(session)); await handle.sync(); }
    finally { await handle.close(); }
    if (replace) await rename(temporary, path);
    else await link(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

export async function removeSession(path = sessionPath()): Promise<void> {
  await loadSession(path);
  await rm(path);
}

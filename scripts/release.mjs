import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TARGETS } from "./targets.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
export async function sha256(path) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest("hex");
}
export async function collectArtifacts(directory, version, revision) {
  if (!/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/.test(version) || !/^[a-f0-9]{40}$/.test(revision)) throw new Error("A stable SemVer and exact source revision are required");
  const files = [];
  for (const { target } of TARGETS) {
    const manifest = JSON.parse(await readFile(join(directory, `manifest-${target}.json`), "utf8"));
    const expected = `engagectl-${version}-${target}.${target.startsWith("windows-") ? "zip" : "tar.gz"}`;
    if (manifest.target !== target || manifest.version !== version || manifest.revision !== revision || manifest.file !== expected || manifest.nodeVersion !== (await readFile(join(root, ".node-version"), "utf8")).trim()) throw new Error(`Artifact provenance mismatch for ${target}`);
    if (await sha256(join(directory, expected)) !== manifest.sha256) throw new Error(`Artifact checksum mismatch for ${target}`);
    files.push(expected);
  }
  const archives = (await readdir(directory)).filter(name => /\.(zip|tar\.gz)$/.test(name));
  if (archives.length !== TARGETS.length || archives.some(name => !files.includes(name))) throw new Error("Unexpected release archives");
  return files;
}

function gh(args, allowMissing = false) {
  const result = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0) {
    if (allowMissing && /HTTP 404/.test(result.stderr ?? "")) return undefined;
    throw new Error(`GitHub operation failed: ${args.slice(0, 2).join(" ")} (exit ${result.status})`);
  }
  return result.stdout;
}

export async function publish() {
  if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" || process.env.GITHUB_REF !== "refs/heads/main" || process.env.GITHUB_REPOSITORY !== "mathias8dev/engage-ctl") throw new Error("Publication requires an explicit workflow dispatch from engage-ctl main");
  const revision = process.env.GITHUB_SHA;
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const directory = join(root, "dist/releases");
  const files = await collectArtifacts(directory, version, revision);
  for (const name of ["install.sh", "install.ps1"]) {
    await copyFile(join(root, name), join(directory, name)); files.push(name);
  }
  const sums = (await Promise.all(files.sort().map(async name => `${await sha256(join(directory, name))}  ${name}`))).join("\n") + "\n";
  await writeFile(join(directory, "SHA256SUMS"), sums); files.push("SHA256SUMS");
  const tag = `v${version}`;
  const repository = process.env.GITHUB_REPOSITORY;
  let reference = gh(["api", `repos/${repository}/git/ref/tags/${tag}`], true);
  if (reference) {
    let object = JSON.parse(reference).object;
    for (let depth = 0; object.type === "tag" && depth < 4; depth++) object = JSON.parse(gh(["api", `repos/${repository}/git/tags/${object.sha}`])).object;
    if (object.type !== "commit" || object.sha !== revision) throw new Error("Refusing to retarget an existing release tag");
  }
  const releaseJson = gh(["api", `repos/${repository}/releases/tags/${tag}`], true);
  const release = releaseJson ? JSON.parse(releaseJson) : undefined;
  const temporary = await mkdtemp(join(tmpdir(), "engagectl-release-"));
  try {
    if (release) {
      for (const asset of release.assets) {
        if (!files.includes(asset.name)) throw new Error(`Unexpected existing release asset: ${asset.name}`);
        gh(["release", "download", tag, "--repo", repository, "--pattern", asset.name, "--dir", temporary]);
        if (await sha256(join(temporary, asset.name)) !== await sha256(join(directory, asset.name))) throw new Error(`Refusing to overwrite release asset ${asset.name}`);
      }
      if (!release.draft) {
        if (files.length !== release.assets.length) throw new Error("Published releases are immutable; bump the version");
        console.log(`Release ${tag} already contains these exact artifacts`); return;
      }
    } else {
      const notes = join(temporary, "notes.md");
      await writeFile(notes, `Standalone engagectl ${version}, including the local MCP server.\n\nSource revision: ${revision}\n\nDownload the archive matching your OS and architecture, verify SHA256SUMS, then run the included binary. Node.js and npm are not required.\n\nmacOS binaries are ad-hoc signed; Windows binaries are unsigned. See README for installation and authentication.\n`);
      gh(["release", "create", tag, "--repo", repository, "--target", revision, "--draft", "--title", `engagectl ${version}`, "--notes-file", notes]);
    }
    const existing = new Set(release?.assets.map(asset => asset.name) ?? []);
    for (const name of files.filter(name => !existing.has(name))) gh(["release", "upload", tag, join(directory, name), "--repo", repository]);
    gh(["release", "edit", tag, "--repo", repository, "--draft=false", "--latest"]);
    console.log(`Published https://github.com/${repository}/releases/tag/${tag}`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== "--publish") throw new Error("Use --publish only from the release workflow");
  await publish();
}

import { inject } from "postject";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { bundle, root } from "./bundle.mjs";

const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const nodeVersion = (await readFile(join(root, ".node-version"), "utf8")).trim();
if (process.version !== `v${nodeVersion}`) throw new Error(`Packaging requires Node ${nodeVersion}; use mise exec -- pnpm package`);
if (!["linux", "darwin", "win32"].includes(process.platform) || !["x64", "arm64"].includes(process.arch)) throw new Error("Unsupported release platform");
await bundle();
const target = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
const label = `engagectl-${metadata.version}-${target}`;
const stage = join(root, "build", label);
const output = join(root, "dist/releases");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await mkdir(output, { recursive: true });
const executable = join(stage, process.platform === "win32" ? "engagectl.exe" : "engagectl");
await copyFile(process.execPath, executable);
await chmod(executable, 0o755);
if (process.platform === "darwin") execFileSync("codesign", ["--remove-signature", executable], { stdio: "inherit" });
const config = join(root, "build/sea-config.json");
const blob = join(root, "build/engagectl.blob");
await writeFile(config, JSON.stringify({ main: join(root, "build/engagectl.cjs"), output: blob,
  disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }));
execFileSync(process.execPath, ["--experimental-sea-config", config], { cwd: root, stdio: "inherit" });
await inject(executable, "NODE_SEA_BLOB", await readFile(blob), {
  sentinelFuse: "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ...(process.platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
});
if (process.platform === "darwin") {
  execFileSync("codesign", ["--sign", "-", executable], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--strict", executable], { stdio: "inherit" });
}
const actual = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
if (actual !== metadata.version) throw new Error(`Packaged version mismatch: ${actual}`);
await copyFile(join(root, "third_party/NODE-LICENSE.txt"), join(stage, "NODE-LICENSE.txt"));
await copyFile(join(root, "build/THIRD-PARTY-NOTICES.txt"), join(stage, "THIRD-PARTY-NOTICES.txt"));
await copyFile(join(root, "README.md"), join(stage, "README.md"));
const revision = process.env.GITHUB_SHA ?? (spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim() || "uncommitted");
const manifest = { version: metadata.version, target, nodeVersion, revision };
await writeFile(join(stage, "BUILD.json"), JSON.stringify(manifest, null, 2) + "\n");
const archive = join(output, `${label}.${process.platform === "win32" ? "zip" : "tar.gz"}`);
await rm(archive, { force: true });
if (process.platform === "win32") {
  execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Compress-Archive -Path (Join-Path $env:ENGAGECTL_STAGE '*') -DestinationPath $env:ENGAGECTL_ARCHIVE"],
    { env: { ...process.env, ENGAGECTL_STAGE: stage, ENGAGECTL_ARCHIVE: archive }, stdio: "inherit" });
} else {
  execFileSync("tar", ["-czf", archive, "-C", stage, "."], { stdio: "inherit" });
}
const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
await writeFile(join(output, `manifest-${target}.json`), JSON.stringify({ ...manifest, file: archive.split(/[\\/]/).at(-1), sha256 }, null, 2) + "\n");
await writeFile(join(root, "build/executable-path.txt"), executable);
console.log(`Packaged ${target}: ${archive}`);

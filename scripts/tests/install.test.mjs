import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { sha256 } from "../release.mjs";
import { fileURLToPath } from "node:url";

test("POSIX installer verifies the archive before atomically replacing an installed binary", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "engagectl-install-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, "fixture");
  const tools = join(root, "tools");
  const bin = join(root, "installed bin");
  const contents = join(root, "contents");
  for (const directory of [fixture, tools, contents, bin]) await mkdir(directory);
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const archive = `engagectl-0.1.0-${os}-${process.arch}.tar.gz`;
  await writeFile(join(contents, "engagectl"), "#!/bin/sh\nprintf '0.1.0\\n'\n");
  await writeFile(join(contents, "NODE-LICENSE.txt"), "runtime license fixture");
  await writeFile(join(contents, "THIRD-PARTY-NOTICES.txt"), "dependency license fixture");
  execFileSync("tar", ["-czf", join(fixture, archive), "-C", contents, "."]);
  await writeFile(join(fixture, "SHA256SUMS"), `${await sha256(join(fixture, archive))}  ${archive}\n`);
  await writeFile(join(tools, "curl"), `#!/bin/sh
set -eu
out=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) out=$2; shift 2;;
    https://*) url=$1; shift;;
    *) shift;;
  esac
done
cp "$ENGAGECTL_INSTALL_FIXTURE/\u0024{url##*/}" "$out"
`);
  await chmod(join(tools, "curl"), 0o755);
  const installer = fileURLToPath(new URL("../../install.sh", import.meta.url));
  const env = { ...process.env, PATH: `${tools}:${process.env.PATH}`, ENGAGECTL_BIN_DIR: bin, ENGAGECTL_INSTALL_FIXTURE: fixture };
  const result = execFileSync("sh", [installer, "0.1.0"], { env, encoding: "utf8" });
  assert.match(result, /Installed/);
  assert.equal(execFileSync(join(bin, "engagectl"), ["--version"], { encoding: "utf8" }).trim(), "0.1.0");
  const previous = await readFile(join(bin, "engagectl"));
  await writeFile(join(fixture, "SHA256SUMS"), `${"0".repeat(64)}  ${archive}\n`);
  assert.throws(() => execFileSync("sh", [installer, "0.1.0"], { env, stdio: "pipe" }), error => /Checksum mismatch/.test(error.stderr.toString()));
  assert.deepEqual(await readFile(join(bin, "engagectl")), previous);
});

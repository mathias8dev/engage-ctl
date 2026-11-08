import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { root } from "./bundle.mjs";
const directory = await mkdtemp(join(tmpdir(), "engagectl-standalone-"));
try {
  const source = await readFile(join(root, "build/executable-path.txt"), "utf8");
  const executable = join(directory, process.platform === "win32" ? "engage ctl.exe" : "engage ctl");
  await copyFile(source, executable);
  execFileSync(executable, ["--version"], { cwd: directory, stdio: "inherit" });
  execFileSync(process.execPath, ["--test", "tests/operator.test.mjs", "tests/tls.test.mjs"], {
    cwd: root, env: { ...process.env, ENGAGECTL_TEST_EXECUTABLE: executable }, stdio: "inherit",
  });
} finally { await rm(directory, { recursive: true, force: true }); }

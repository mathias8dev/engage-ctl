import { build } from "esbuild";
import { isBuiltin } from "node:module";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export async function bundle() {
  await mkdir(join(root, "build"), { recursive: true });
  const result = await build({ absWorkingDir: root, entryPoints: ["src/cli.ts"], bundle: true,
    platform: "node", target: "node24.16", format: "cjs", outfile: "build/engagectl.cjs",
    metafile: true, legalComments: "external" });
  const external = Object.values(result.metafile.outputs).flatMap(output => output.imports)
    .filter(item => item.external && !isBuiltin(item.path));
  if (external.length) throw new Error(`Unbundled runtime dependencies: ${external.map(item => item.path).join(", ")}`);
  const notices = new Map();
  for (const input of Object.keys(result.metafile.inputs).filter(path => path.includes("node_modules/"))) {
    let directory = dirname(await realpath(resolve(root, input)));
    while (directory !== dirname(directory)) {
      const manifest = await readFile(join(directory, "package.json"), "utf8").then(JSON.parse).catch(error => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (manifest?.name) {
        const key = `${manifest.name}@${manifest.version}`;
        if (!notices.has(key)) {
          const names = (await readdir(directory)).filter(name => /^(licen[cs]e|notice)(\.|$)/i.test(name));
          if (!names.length) throw new Error(`Missing bundled dependency license: ${key}`);
          notices.set(key, (await Promise.all(names.sort().map(async name => `${name}\n${await readFile(join(directory, name), "utf8")}`))).join("\n"));
        }
        break;
      }
      directory = dirname(directory);
    }
  }
  await writeFile(join(root, "build/THIRD-PARTY-NOTICES.txt"), [...notices].sort(([a], [b]) => a.localeCompare(b))
    .map(([name, license]) => `===== ${name} =====\n${license}`).join("\n\n"));
}

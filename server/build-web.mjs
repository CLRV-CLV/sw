import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
const web = new URL("../web/", import.meta.url);
const result = spawnSync("npm", ["run", "generate"], {
  cwd: web,
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status || 1);
const dest = new URL("./public/", import.meta.url);
mkdirSync(dest, { recursive: true });
cpSync(new URL("../web/.output/public/", import.meta.url), dest, {
  recursive: true,
});

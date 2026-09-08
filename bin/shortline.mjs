#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "..", "dist", "cli.js");
if (existsSync(dist)) {
  await import(dist);
} else {
  const { register } = await import("node:module");
  register("tsx", import.meta.url);
  await import(join(here, "..", "src", "cli.ts"));
}

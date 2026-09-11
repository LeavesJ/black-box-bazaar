// agents/src/log.ts
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// demo/logs by default; LOG_DIR moves it, so a presenter run (demo/console.mjs) never writes over a recording's logs.
const LOG_DIR = process.env.LOG_DIR || join(here, "..", "..", "demo", "logs");

export function logger(role: string) {
  mkdirSync(LOG_DIR, { recursive: true });
  const file = join(LOG_DIR, `${role}.log`);
  return (event: string, fields: Record<string, unknown> = {}) => {
    const line = JSON.stringify({ t: new Date().toISOString(), role, event, ...fields },
      (_, v) => (typeof v === "bigint" ? v.toString() : v));
    console.log(line);
    appendFileSync(file, line + "\n");
  };
}

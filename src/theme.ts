import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { config } from "./config.ts";
import { mainThemeId } from "./store.ts";

const run = promisify(execFile);
const CLI = path.resolve("node_modules/.bin/shopify");

// theme file writes through the admin api need a shopify exemption, so writes go through
// the shopify cli, which authenticates as the store's staff account (or a theme access password)
async function cli(args: string[]): Promise<string> {
  try {
    const { stdout } = await run(CLI, args, { maxBuffer: 20 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } });
    return stdout;
  } catch (e: any) {
    // the cli exits non-zero on upload errors but still prints the json result we need
    if (e.stdout) return e.stdout;
    throw new Error(`shopify cli failed: ${e.stderr || e.message}`);
  }
}

function lastJson(stdout: string): any {
  const lines = stdout.trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type !== "progress" && parsed.type !== "diagnostic") return parsed;
    } catch {}
  }
  return {};
}

async function pushArgs(dir: string, only: string[], allowDelete: boolean): Promise<string[]> {
  const themeId = (await mainThemeId()).split("/").pop()!;
  return [
    "theme", "push",
    "--store", config.shopDomain,
    "--theme", themeId,
    "--path", dir,
    ...only.flatMap((f) => ["--only", f]),
    "--allow-live", "--json", "--no-input", "--force",
    ...(allowDelete ? [] : ["--nodelete"]),
  ];
}

export async function pushFiles(dir: string, files: string[]): Promise<Record<string, string[]>> {
  const result = lastJson(await cli(await pushArgs(dir, files, false)));
  if (result.error) throw new Error(result.error.message);
  return result.theme?.errors ?? {};
}

// pushing an empty directory scoped with --only removes just those files from the theme
export async function deleteFiles(files: string[]): Promise<void> {
  const empty = await mkdtemp(path.join(tmpdir(), "theme-delete-"));
  try {
    await cli(await pushArgs(empty, files, true));
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
}

export interface Offense {
  file: string;
  check: string;
  severity: string;
  line: number;
  message: string;
}

export async function themeCheck(dir: string): Promise<Offense[]> {
  const out = await cli(["theme", "check", "--path", dir, "--output", "json", "--fail-level", "crash"]);
  const start = out.indexOf("[");
  if (start < 0) return [];
  const reports = JSON.parse(out.slice(start)) as { path: string; offenses: any[] }[];
  return reports.flatMap((r) =>
    r.offenses.map((o) => ({
      file: path.relative(dir, r.path),
      check: o.check,
      severity: o.severity,
      line: o.start_row + 1,
      message: o.message,
    })),
  );
}

export async function writeLocal(dir: string, filename: string, content: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, filename)), { recursive: true });
  await writeFile(path.join(dir, filename), content);
}

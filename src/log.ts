// plain ansi output so a recording of the run reads clearly without extra dependencies
const c = (code: number) => (s: string) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c(2);
const cyan = c(36);
const green = c(32);
const yellow = c(33);
const bold = c(1);
const started = Date.now();
const elapsed = () => dim(`[${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s]`);

export const log = {
  title: (s: string) => console.log(`\n${bold(s)}`),
  step: (s: string) => console.log(`${elapsed()} ${cyan("→")} ${s}`),
  ok: (s: string) => console.log(`${elapsed()} ${green("✓")} ${s}`),
  warn: (s: string, detail?: unknown) => console.log(`${elapsed()} ${yellow("!")} ${s}${detail !== undefined ? dim(` (${detail})`) : ""}`),
  agent: (s: string) => console.log(`${elapsed()} ${dim("agent:")} ${s}`),
  tool: (s: string) => console.log(`${elapsed()} ${dim("tool:")} ${s}`),
  info: (s: string) => console.log(`       ${s}`),
};

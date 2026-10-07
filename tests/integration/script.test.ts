import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("../../", import.meta.url).pathname;

test.each([
  ["direct Bun execution", ["bun", "run", "src/index.ts"]],
  ["existing start script", ["bun", "run", "start"]],
])("%s reports configuration errors and exits nonzero", async (_name, command) => {
  const process = Bun.spawn(command, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  expect(exitCode).toBe(1);
  expect(stderr).toContain("Invalid audit configuration");
  expect(stderr).toContain("startUrl");
  expect(stderr).toContain("src/config.ts");
  expect(stdout).not.toContain("Hello via Bun");
});

test("fatal execution exits nonzero and writes failed partial artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "craw-script-execution-"));
  try {
    const preload = join(directory, "configure.ts");
    await Bun.write(
      preload,
      `
      import { config } from ${JSON.stringify(new URL("../../src/config.ts", import.meta.url).href)};
      import { systemClock } from ${JSON.stringify(new URL("../../src/audit-run.ts", import.meta.url).href)};
      config.startUrl = "http://127.0.0.1/";
      systemClock.sleep = () => { throw new Error("Injected fatal scheduler failure"); };
      process.chdir(${JSON.stringify(directory)});
    `,
    );
    const process = Bun.spawn(["bun", "--preload", preload, join(root, "src/index.ts")], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("failed");
    const report = await Bun.file(join(directory, "audit-report.html")).text();
    expect(report).toContain("Partial report");
    expect(report).toContain("Injected fatal scheduler failure");
    expect(await Bun.file(join(directory, "audit.sqlite")).exists()).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("valid configuration exits nonzero on a fatal persistence failure without live network work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "craw-script-"));
  try {
    const preload = join(directory, "configure.ts");
    const configModule = new URL("../../src/config.ts", import.meta.url).href;
    await mkdir(join(directory, "audit.sqlite"));
    await Bun.write(
      preload,
      `import { config } from ${JSON.stringify(configModule)}; config.startUrl = "http://127.0.0.1/"; process.chdir(${JSON.stringify(directory)});`,
    );
    const process = Bun.spawn(["bun", "--preload", preload, join(root, "src/index.ts")], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      process.exited,
      new Response(process.stderr).text(),
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/database|sqlite|directory|open/iu);
    expect(stderr).not.toContain("Invalid audit configuration");
    const report = await Bun.file(join(directory, "audit-report.html")).text();
    expect(report).toContain("Partial report");
    expect(report).toContain("failed");
    expect(report).toContain("refused");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

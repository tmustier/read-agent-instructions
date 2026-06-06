import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { AgentInstructionCollector } from "../src/collector.ts";

async function makeWorkspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "read-agent-instructions-adversarial-"));
}

async function createGitRepo(path: string): Promise<void> {
  await mkdir(join(path, ".git"), { recursive: true });
}

async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

test("does not leak parent workspace instructions into a nested git project", async () => {
  const workspace = await makeWorkspace();
  const repo = join(workspace, "repo");
  await writeTextFile(join(workspace, "AGENTS.md"), "Parent workspace instruction must not leak into repo.");
  await createGitRepo(repo);
  await writeTextFile(join(repo, "AGENTS.md"), "Nested repo instruction only.");
  await writeTextFile(join(repo, "src", "file.ts"), "export const value = 1;\n");

  const collector = new AgentInstructionCollector();
  const discoveries = await collector.collectForRead({ cwd: workspace, requestedPath: join(repo, "src", "file.ts") });

  assert.deepEqual(discoveries.map((discovery) => discovery.content), ["Nested repo instruction only."]);
  assert.ok(discoveries.every((discovery) => !discovery.content.includes("must not leak")));
});

test("does not inject an instruction file into its own read result", async () => {
  const workspace = await makeWorkspace();
  const repo = join(workspace, "repo");
  const agentsPath = join(repo, "AGENTS.md");
  await createGitRepo(repo);
  await writeTextFile(agentsPath, "Self read should not be echoed as hidden instructions.");

  const collector = new AgentInstructionCollector();
  const discoveries = await collector.collectForRead({ cwd: workspace, requestedPath: agentsPath });

  assert.equal(discoveries.length, 0);
});

test("does not mark a glob-filtered instruction as announced before a matching read", async () => {
  const workspace = await makeWorkspace();
  const repo = join(workspace, "repo");
  await createGitRepo(repo);
  await writeTextFile(
    join(repo, "AGENTS.md"),
    ["---", "globs:", "  - '**/*.ts'", "---", "TypeScript rules should appear only for TS files."].join("\n"),
  );
  await writeTextFile(join(repo, "README.md"), "# no match\n");
  await writeTextFile(join(repo, "src", "file.ts"), "export const value = 1;\n");

  const collector = new AgentInstructionCollector();
  const markdownDiscoveries = await collector.collectForRead({ cwd: workspace, requestedPath: join(repo, "README.md") });
  const typeScriptDiscoveries = await collector.collectForRead({ cwd: workspace, requestedPath: join(repo, "src", "file.ts") });

  assert.equal(markdownDiscoveries.length, 0);
  assert.deepEqual(typeScriptDiscoveries.map((discovery) => discovery.content), [
    "TypeScript rules should appear only for TS files.",
  ]);
});

test("truncates oversized instruction payloads instead of flooding the read result", async () => {
  const workspace = await makeWorkspace();
  const repo = join(workspace, "repo");
  const longInstruction = `start-${"x".repeat(200)}-end`;
  await createGitRepo(repo);
  await writeTextFile(join(repo, "AGENTS.md"), longInstruction);
  await writeTextFile(join(repo, "file.txt"), "content\n");

  const collector = new AgentInstructionCollector({ maxBytesPerFile: 48, maxBytesPerResult: 96 });
  const discoveries = await collector.collectForRead({ cwd: workspace, requestedPath: join(repo, "file.txt") });
  const content = discoveries[0]?.content ?? "";

  assert.equal(discoveries.length, 1);
  assert.equal(discoveries[0]?.truncated, true);
  assert.match(content, /Instruction file truncated/);
  assert.ok(!content.includes("-end"));
});

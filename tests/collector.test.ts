import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { AgentInstructionCollector } from "../src/collector.ts";
import { formatInstructionBlock } from "../src/format.ts";

async function makeWorkspace(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "read-agent-instructions-"));
}

async function createGitRepo(path: string): Promise<void> {
  await mkdir(join(path, ".git"), { recursive: true });
}

async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function touch(path: string): Promise<void> {
  const now = new Date(Date.now() + 1500);
  await utimes(path, now, now);
}

test("collects project and subtree instructions for the file that was read", async () => {
  const workspace = await makeWorkspace();
  const repoA = join(workspace, "repoA");
  await createGitRepo(repoA);
  await writeTextFile(join(repoA, "AGENTS.md"), "Repo A root rules");
  await writeTextFile(join(repoA, "service", "AGENTS.md"), "Repo A service rules");
  await writeTextFile(join(repoA, "service", "index.ts"), "export const value = 1;\n");

  const collector = new AgentInstructionCollector();
  const discoveries = await collector.collectForRead({ cwd: workspace, requestedPath: join(repoA, "service", "index.ts") });

  assert.deepEqual(
    discoveries.map((discovery) => discovery.displayPath),
    ["repoA/AGENTS.md", "repoA/service/AGENTS.md"],
  );
  assert.deepEqual(
    discoveries.map((discovery) => discovery.content),
    ["Repo A root rules", "Repo A service rules"],
  );

  const block = formatInstructionBlock(discoveries, { cwd: workspace });
  assert.match(block, /Repo A root rules/);
  assert.match(block, /Repo A service rules/);
});

test("keeps multiple git projects isolated when cwd is their parent", async () => {
  const workspace = await makeWorkspace();
  const repoA = join(workspace, "repoA");
  const repoB = join(workspace, "repoB");
  await createGitRepo(repoA);
  await createGitRepo(repoB);
  await writeTextFile(join(repoA, "AGENTS.md"), "Repo A only");
  await writeTextFile(join(repoA, "src", "file.ts"), "export const a = 1;\n");
  await writeTextFile(join(repoB, "AGENTS.md"), "Repo B only");
  await writeTextFile(join(repoB, "src", "file.ts"), "export const b = 1;\n");

  const collector = new AgentInstructionCollector();
  const repoADiscoveries = await collector.collectForRead({ cwd: workspace, requestedPath: join(repoA, "src", "file.ts") });
  const repoBDiscoveries = await collector.collectForRead({ cwd: workspace, requestedPath: join(repoB, "src", "file.ts") });

  assert.deepEqual(repoADiscoveries.map((discovery) => discovery.content), ["Repo A only"]);
  assert.deepEqual(repoBDiscoveries.map((discovery) => discovery.content), ["Repo B only"]);
});

test("deduplicates repeated instruction payloads and re-announces when a file changes", async () => {
  const workspace = await makeWorkspace();
  const repo = join(workspace, "repo");
  const agents = join(repo, "AGENTS.md");
  const source = join(repo, "src", "file.ts");
  await createGitRepo(repo);
  await writeTextFile(agents, "Rules v1");
  await writeTextFile(source, "export const value = 1;\n");

  const collector = new AgentInstructionCollector();
  const first = await collector.collectForRead({ cwd: workspace, requestedPath: source });
  const second = await collector.collectForRead({ cwd: workspace, requestedPath: source });
  const statsAfterSecond = collector.getCacheStats();

  assert.deepEqual(first.map((discovery) => discovery.content), ["Rules v1"]);
  assert.equal(second.length, 0);
  assert.equal(statsAfterSecond.filesRead, 1);
  assert.ok(statsAfterSecond.cacheHits >= 1);

  await writeTextFile(agents, "Rules v2 changed");
  await touch(agents);
  const third = await collector.collectForRead({ cwd: workspace, requestedPath: source });

  assert.deepEqual(third.map((discovery) => discovery.content), ["Rules v2 changed"]);
});

test("honors simple globs frontmatter to avoid irrelevant instruction spam", async () => {
  const workspace = await makeWorkspace();
  const repo = join(workspace, "repo");
  await createGitRepo(repo);
  await writeTextFile(
    join(repo, "AGENTS.md"),
    ["---", "globs:", "  - '**/*.ts'", "---", "TypeScript-only rules"].join("\n"),
  );
  await writeTextFile(join(repo, "src", "file.ts"), "export const value = 1;\n");
  await writeTextFile(join(repo, "docs", "guide.md"), "# Guide\n");

  const markdownCollector = new AgentInstructionCollector();
  const markdownDiscoveries = await markdownCollector.collectForRead({
    cwd: workspace,
    requestedPath: join(repo, "docs", "guide.md"),
  });
  assert.equal(markdownDiscoveries.length, 0);

  const typeScriptCollector = new AgentInstructionCollector();
  const typeScriptDiscoveries = await typeScriptCollector.collectForRead({
    cwd: workspace,
    requestedPath: join(repo, "src", "file.ts"),
  });
  assert.deepEqual(typeScriptDiscoveries.map((discovery) => discovery.content), ["TypeScript-only rules"]);
});

test("uses the highest-priority instruction filename in each directory", async () => {
  const workspace = await makeWorkspace();
  const repo = join(workspace, "repo");
  await createGitRepo(repo);
  await writeTextFile(join(repo, "CLAUDE.md"), "Claude fallback");
  await writeTextFile(join(repo, "AGENTS.md"), "Agents preferred");
  await writeTextFile(join(repo, "file.txt"), "content\n");

  const collector = new AgentInstructionCollector();
  const discoveries = await collector.collectForRead({ cwd: workspace, requestedPath: join(repo, "file.txt") });

  assert.deepEqual(discoveries.map((discovery) => discovery.content), ["Agents preferred"]);
});

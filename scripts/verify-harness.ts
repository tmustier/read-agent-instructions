import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentInstructionCollector } from "../src/collector.ts";
import { formatInstructionBlock } from "../src/format.ts";

interface SimulatedToolResult {
  label: string;
  path: string;
  content: string;
}

async function writeTextFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function createScenario(): Promise<{ workspace: string; repoA: string; results: SimulatedToolResult[] }> {
  const workspace = await mkdtemp(join(tmpdir(), "read-agent-instructions-harness-"));
  const repoA = join(workspace, "repoA");
  const repoB = join(workspace, "repoB");

  await mkdir(join(repoA, ".git"), { recursive: true });
  await mkdir(join(repoB, ".git"), { recursive: true });

  await writeTextFile(join(workspace, "AGENTS.md"), "Parent workspace instruction: this must not leak into child git repos.");
  await writeTextFile(join(repoA, "AGENTS.md"), "Repo A root instruction: run npm test before claiming done.");
  await writeTextFile(
    join(repoA, "packages", "api", "AGENTS.md"),
    "Repo A API instruction: use strict request validation.",
  );
  await writeTextFile(join(repoA, "packages", "api", "src", "handler.ts"), "export const handler = () => 'ok';\n");

  await writeTextFile(join(repoB, "AGENTS.md"), "Repo B root instruction: use pnpm for all commands.");
  await writeTextFile(join(repoB, "app", "src", "main.ts"), "export const main = () => 'ok';\n");

  return {
    workspace,
    repoA,
    results: [
      {
        label: "repoA first read",
        path: join(repoA, "packages", "api", "src", "handler.ts"),
        content: "export const handler = () => 'ok';",
      },
      {
        label: "repoA repeated read",
        path: join(repoA, "packages", "api", "src", "handler.ts"),
        content: "export const handler = () => 'ok';",
      },
      {
        label: "repoB first read",
        path: join(repoB, "app", "src", "main.ts"),
        content: "export const main = () => 'ok';",
      },
    ],
  };
}

async function main(): Promise<void> {
  const proofMode = process.argv.includes("--tmux-proof");
  const { workspace, repoA, results } = await createScenario();
  const collector = new AgentInstructionCollector();

  console.log(`workspace=${workspace}`);

  const payloads: { label: string; payload: string; discovered: string[] }[] = [];

  for (const result of results) {
    const discoveries = await collector.collectForRead({ cwd: workspace, requestedPath: result.path });
    const instructionBlock = formatInstructionBlock(discoveries, { cwd: workspace });
    const simulatedPayload = instructionBlock.length > 0 ? `${result.content}\n${instructionBlock}` : result.content;
    const discovered = discoveries.map((discovery) => discovery.displayPath);
    payloads.push({ label: result.label, payload: simulatedPayload, discovered });

    console.log(`\n=== ${result.label} ===`);
    console.log(simulatedPayload);
    console.log(`discovered=${discovered.join(",")}`);
  }

  const stats = collector.getCacheStats();
  console.log("\n=== cache/dedup stats ===");
  console.log(JSON.stringify(stats, undefined, 2));

  if (proofMode) {
    const repoAFirst = payloads.find((payload) => payload.label === "repoA first read");
    const repoARepeated = payloads.find((payload) => payload.label === "repoA repeated read");
    const repoBFirst = payloads.find((payload) => payload.label === "repoB first read");
    const repoAHasRoot = repoAFirst?.payload.includes("Repo A root instruction") ?? false;
    const repoAHasSubtree = repoAFirst?.payload.includes("Repo A API instruction") ?? false;
    const repeatedHasNoInstruction = !(repoARepeated?.payload.includes("<agent-instructions>") ?? true);
    const repoBIsIsolated =
      (repoBFirst?.payload.includes("Repo B root instruction") ?? false) &&
      !(repoBFirst?.payload.includes("Repo A root instruction") ?? true);
    const parentInstructionDidNotLeak = !(repoAFirst?.payload.includes("Parent workspace instruction") ?? true);

    const adversarialCollector = new AgentInstructionCollector();
    const selfReadDiscoveries = await adversarialCollector.collectForRead({
      cwd: workspace,
      requestedPath: join(repoA, "AGENTS.md"),
    });
    const selfReadDidNotEcho = selfReadDiscoveries.length === 0;

    console.log(`\nTMUX_PROOF repoA_payload_has_root_instruction=${repoAHasRoot}`);
    console.log(`TMUX_PROOF repoA_payload_has_subtree_instruction=${repoAHasSubtree}`);
    console.log(`TMUX_PROOF repeated_repoA_read_has_no_repeated_instruction=${repeatedHasNoInstruction}`);
    console.log(`TMUX_PROOF repoB_payload_isolated_from_repoA=${repoBIsIsolated}`);
    console.log(`TMUX_PROOF parent_workspace_instruction_did_not_leak=${parentInstructionDidNotLeak}`);
    console.log(`TMUX_PROOF agents_md_self_read_did_not_echo=${selfReadDidNotEcho}`);

    if (
      !repoAHasRoot ||
      !repoAHasSubtree ||
      !repeatedHasNoInstruction ||
      !repoBIsIsolated ||
      !parentInstructionDidNotLeak ||
      !selfReadDidNotEcho
    ) {
      throw new Error("tmux proof assertions failed");
    }
  }
}

await main();

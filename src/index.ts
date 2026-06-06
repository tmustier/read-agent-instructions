import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isReadToolResult } from "@earendil-works/pi-coding-agent";
import { AgentInstructionCollector } from "./collector.ts";
import { formatInstructionBlock } from "./format.ts";

function readPathFromInput(input: Record<string, unknown>): string | undefined {
  const value = input["path"];
  if (typeof value !== "string") {
    return undefined;
  }

  if (value.startsWith("@")) {
    return value.slice(1);
  }

  return value;
}

export default function readAgentInstructions(pi: ExtensionAPI): void {
  const collector = new AgentInstructionCollector();

  pi.on("tool_result", async (event, ctx) => {
    if (!isReadToolResult(event) || event.isError) {
      return;
    }

    const requestedPath = readPathFromInput(event.input);
    if (requestedPath === undefined || requestedPath.trim().length === 0 || requestedPath === "-") {
      return;
    }

    const discoveries = await collector.collectForRead({
      requestedPath,
      cwd: ctx.cwd,
      signal: ctx.signal,
    });

    if (discoveries.length === 0) {
      return;
    }

    const instructionBlock = formatInstructionBlock(discoveries, { cwd: ctx.cwd });
    return {
      content: [...event.content, { type: "text", text: instructionBlock }],
    };
  });

  pi.registerCommand("read-agent-instructions:stats", {
    description: "Show read-agent-instructions cache and dedupe stats",
    handler: async (_args, ctx) => {
      const stats = collector.getCacheStats();
      ctx.ui.notify(
        [
          "read-agent-instructions stats",
          `cache entries: ${stats.cacheEntries}`,
          `cache hits: ${stats.cacheHits}`,
          `files read: ${stats.filesRead}`,
          `announced instruction versions: ${stats.announcedInstructionVersions}`,
        ].join("\n"),
        "info",
      );
    },
  });
}

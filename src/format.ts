import type { InstructionDiscovery } from "./types.ts";

export interface FormatOptions {
  cwd: string;
}

function sourceLabel(source: InstructionDiscovery["source"]): string {
  if (source === "project") {
    return "project";
  }
  return "subtree";
}

export function formatInstructionBlock(discoveries: readonly InstructionDiscovery[], _options: FormatOptions): string {
  if (discoveries.length === 0) {
    return "";
  }

  const lines: string[] = [
    "",
    "<agent-instructions>",
    "The read-agent-instructions Pi extension found instruction files adjacent to or above the file that was just read. Apply these instructions to work in the corresponding subtree. More specific files appear later and should override broader guidance when they conflict.",
  ];

  for (const discovery of discoveries) {
    const truncationNote = discovery.truncated ? " truncated" : "";
    lines.push(
      "",
      `--- ${discovery.displayPath} (${sourceLabel(discovery.source)}, ${discovery.lineCount} lines${truncationNote}) ---`,
      discovery.content,
    );
  }

  lines.push("</agent-instructions>");
  return lines.join("\n");
}

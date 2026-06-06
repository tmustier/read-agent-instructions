import type { ParsedInstructionFile } from "./types.ts";

function stripInlineComment(value: string): string {
  const hashIndex = value.indexOf("#");
  if (hashIndex === -1) {
    return value;
  }
  return value.slice(0, hashIndex);
}

function trimQuotes(value: string): string {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseInlineGlobList(value: string): string[] {
  const trimmed = stripInlineComment(value).trim();
  if (trimmed.length === 0) {
    return [];
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1);
    return inner
      .split(",")
      .map((entry) => trimQuotes(entry))
      .filter((entry) => entry.length > 0);
  }

  return [trimQuotes(trimmed)].filter((entry) => entry.length > 0);
}

function parseFrontmatterGlobs(frontmatter: string): string[] {
  const globs: string[] = [];
  const lines = frontmatter.split(/\r?\n/);
  let readingGlobBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }

    if (readingGlobBlock) {
      if (trimmed.startsWith("-")) {
        const value = trimmed.slice(1).trim();
        globs.push(...parseInlineGlobList(value));
        continue;
      }

      if (!line.startsWith(" ") && !line.startsWith("\t")) {
        readingGlobBlock = false;
      }
    }

    if (trimmed === "globs:" || trimmed === "paths:") {
      readingGlobBlock = true;
      continue;
    }

    if (trimmed.startsWith("globs:") || trimmed.startsWith("paths:")) {
      const colonIndex = trimmed.indexOf(":");
      if (colonIndex !== -1) {
        globs.push(...parseInlineGlobList(trimmed.slice(colonIndex + 1)));
      }
    }
  }

  return globs;
}

export function parseInstructionFile(rawContent: string): ParsedInstructionFile {
  const normalized = rawContent.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { body: normalized.trim(), globs: [] };
  }

  const closingIndex = normalized.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    return { body: normalized.trim(), globs: [] };
  }

  const frontmatter = normalized.slice(4, closingIndex);
  const body = normalized.slice(closingIndex + 5).trim();
  return { body, globs: parseFrontmatterGlobs(frontmatter) };
}

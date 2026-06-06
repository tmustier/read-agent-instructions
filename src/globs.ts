import { basename, relative, resolve } from "node:path";

function toPosixPath(value: string): string {
  return value.replaceAll("\\", "/");
}

function escapeRegexChar(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globPatternToRegex(pattern: string): RegExp {
  let regex = "^";
  let index = 0;

  while (index < pattern.length) {
    const current = pattern[index];
    const next = pattern[index + 1];
    const afterNext = pattern[index + 2];

    if (current === "*" && next === "*" && afterNext === "/") {
      regex += "(?:.*/)?";
      index += 3;
      continue;
    }

    if (current === "*" && next === "*") {
      regex += ".*";
      index += 2;
      continue;
    }

    if (current === "*") {
      regex += "[^/]*";
      index += 1;
      continue;
    }

    if (current === "?") {
      regex += "[^/]";
      index += 1;
      continue;
    }

    if (current === undefined) {
      break;
    }

    regex += escapeRegexChar(current);
    index += 1;
  }

  regex += "$";
  return new RegExp(regex);
}

function normalizeGlob(rawPattern: string): string {
  let pattern = rawPattern.trim();
  if ((pattern.startsWith("\"") && pattern.endsWith("\"")) || (pattern.startsWith("'") && pattern.endsWith("'"))) {
    pattern = pattern.slice(1, -1);
  }
  return toPosixPath(pattern.trim());
}

function patternMatches(pattern: string, candidates: readonly string[]): boolean {
  const regex = globPatternToRegex(pattern);
  return candidates.some((candidate) => regex.test(candidate));
}

export function matchesInstructionGlobs(
  globs: readonly string[],
  targetPath: string,
  instructionDirectory: string,
  searchRoot: string,
): boolean {
  if (globs.length === 0) {
    return true;
  }

  const absoluteTarget = toPosixPath(resolve(targetPath));
  const relativeToInstruction = toPosixPath(relative(instructionDirectory, targetPath));
  const relativeToRoot = toPosixPath(relative(searchRoot, targetPath));
  const targetBasename = basename(targetPath);

  for (const rawGlob of globs) {
    const glob = normalizeGlob(rawGlob);
    if (glob.length === 0) {
      continue;
    }

    if (glob.startsWith("./") || glob.startsWith("../")) {
      const absolutePattern = toPosixPath(resolve(instructionDirectory, glob));
      if (patternMatches(absolutePattern, [absoluteTarget])) {
        return true;
      }
      continue;
    }

    if (glob.startsWith("/")) {
      if (patternMatches(glob, [absoluteTarget])) {
        return true;
      }
      continue;
    }

    const candidates = glob.includes("/")
      ? [relativeToRoot, relativeToInstruction]
      : [targetBasename, relativeToRoot, relativeToInstruction];
    const implicitPattern = glob.includes("/") || glob.startsWith("**/") ? glob : `**/${glob}`;

    if (patternMatches(glob, candidates) || patternMatches(implicitPattern, candidates)) {
      return true;
    }
  }

  return false;
}

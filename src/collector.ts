import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { matchesInstructionGlobs } from "./globs.ts";
import { parseInstructionFile } from "./frontmatter.ts";
import type {
  CacheStats,
  CollectForReadInput,
  CollectorOptions,
  InstructionDiscovery,
  InstructionSource,
  ParsedInstructionFile,
} from "./types.ts";

const DEFAULT_INSTRUCTION_FILE_NAMES: readonly string[] = Object.freeze([
  "AGENTS.md",
  "Agents.md",
  "agents.md",
  "AGENT.md",
  "Agent.md",
  "agent.md",
  "CLAUDE.md",
]);

const DEFAULT_MAX_BYTES_PER_FILE = 32 * 1024;
const DEFAULT_MAX_BYTES_PER_RESULT = 64 * 1024;

interface CandidateInstructionFile {
  path: string;
  source: InstructionSource;
}

interface CachedInstructionFile extends ParsedInstructionFile {
  path: string;
  realPath: string;
  mtimeMs: number;
  size: number;
  lineCount: number;
}

interface TruncatedText {
  text: string;
  truncated: boolean;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error("read-agent-instructions collection aborted");
  }
}

function isInsideOrEqual(parentDirectory: string, childPath: string): boolean {
  const relativePath = relative(parentDirectory, childPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function displayPath(path: string, cwd: string): string {
  const relativePath = relative(cwd, path);
  if (relativePath === "") {
    return ".";
  }
  if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath;
  }
  return path;
}

function lineCount(value: string): number {
  if (value.length === 0) {
    return 0;
  }
  return value.split(/\r?\n/).length;
}

function versionKey(file: CachedInstructionFile): string {
  return `${file.realPath}:${file.mtimeMs}:${file.size}`;
}

function truncateUtf8(value: string, maxBytes: number): TruncatedText {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return { text: value, truncated: false };
  }

  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = value.slice(0, middle);
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  const truncated = value.slice(0, low).trimEnd();
  return {
    text: `${truncated}\n\n[Instruction file truncated by read-agent-instructions at ${maxBytes} bytes.]`,
    truncated: true,
  };
}

async function safeRealpath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function directoriesFromRootToLeaf(rootDirectory: string, leafDirectory: string): string[] {
  if (!isInsideOrEqual(rootDirectory, leafDirectory)) {
    return [leafDirectory];
  }

  const directories: string[] = [];
  let current = leafDirectory;

  while (isInsideOrEqual(rootDirectory, current)) {
    directories.unshift(current);
    if (current === rootDirectory) {
      break;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return directories;
}

export class AgentInstructionCollector {
  private readonly instructionFileNames: readonly string[];
  private readonly maxBytesPerFile: number;
  private readonly maxBytesPerResult: number;
  private readonly contentCache = new Map<string, CachedInstructionFile>();
  private readonly announcedInstructionVersions = new Set<string>();
  private cacheHits = 0;
  private filesRead = 0;

  public constructor(options: CollectorOptions = {}) {
    this.instructionFileNames = options.instructionFileNames ?? DEFAULT_INSTRUCTION_FILE_NAMES;
    this.maxBytesPerFile = options.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
    this.maxBytesPerResult = options.maxBytesPerResult ?? DEFAULT_MAX_BYTES_PER_RESULT;
  }

  public getCacheStats(): CacheStats {
    return {
      cacheEntries: this.contentCache.size,
      cacheHits: this.cacheHits,
      filesRead: this.filesRead,
      announcedInstructionVersions: this.announcedInstructionVersions.size,
    };
  }

  public clearAnnouncedInstructions(): void {
    this.announcedInstructionVersions.clear();
  }

  public async collectForRead(input: CollectForReadInput): Promise<InstructionDiscovery[]> {
    throwIfAborted(input.signal);

    const targetPath = resolve(input.cwd, input.requestedPath);
    const targetDirectory = dirname(targetPath);
    const realTargetPath = await safeRealpath(targetPath);
    const realTargetDirectory = await safeRealpath(targetDirectory);
    const realCwd = await safeRealpath(resolve(input.cwd));
    const searchRoot = await this.findSearchRoot(realTargetDirectory, realCwd, input.signal);
    const candidates = await this.findCandidateInstructionFiles(searchRoot, realTargetDirectory, input.signal);

    const discoveries: InstructionDiscovery[] = [];
    const seenRealPaths = new Set<string>();
    let remainingBytes = this.maxBytesPerResult;

    for (const candidate of candidates) {
      throwIfAborted(input.signal);
      const instructionFile = await this.loadInstructionFile(candidate.path, input.signal);
      if (instructionFile === undefined) {
        continue;
      }

      if (instructionFile.realPath === realTargetPath || seenRealPaths.has(instructionFile.realPath)) {
        continue;
      }
      seenRealPaths.add(instructionFile.realPath);

      if (!matchesInstructionGlobs(instructionFile.globs, realTargetPath, dirname(instructionFile.realPath), searchRoot)) {
        continue;
      }

      const key = versionKey(instructionFile);
      if (this.announcedInstructionVersions.has(key)) {
        continue;
      }

      if (remainingBytes <= 0) {
        break;
      }

      const maxForThisFile = Math.min(this.maxBytesPerFile, remainingBytes);
      const truncated = truncateUtf8(instructionFile.body, maxForThisFile);
      remainingBytes -= Buffer.byteLength(truncated.text, "utf8");
      this.announcedInstructionVersions.add(key);

      discoveries.push({
        path: instructionFile.path,
        realPath: instructionFile.realPath,
        displayPath: displayPath(instructionFile.path, realCwd),
        source: candidate.source,
        content: truncated.text,
        lineCount: instructionFile.lineCount,
        truncated: truncated.truncated,
        versionKey: key,
      });
    }

    return discoveries;
  }

  private async findSearchRoot(
    realTargetDirectory: string,
    realCwd: string,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const gitRoot = await this.findNearestGitRoot(realTargetDirectory, signal);
    if (gitRoot !== undefined) {
      return gitRoot;
    }

    if (isInsideOrEqual(realCwd, realTargetDirectory)) {
      return realCwd;
    }

    return realTargetDirectory;
  }

  private async findNearestGitRoot(startDirectory: string, signal: AbortSignal | undefined): Promise<string | undefined> {
    let current = startDirectory;

    while (true) {
      throwIfAborted(signal);
      if (await pathExists(join(current, ".git"))) {
        return current;
      }

      const parent = dirname(current);
      if (parent === current) {
        return undefined;
      }
      current = parent;
    }
  }

  private async findCandidateInstructionFiles(
    searchRoot: string,
    targetDirectory: string,
    signal: AbortSignal | undefined,
  ): Promise<CandidateInstructionFile[]> {
    const directories = directoriesFromRootToLeaf(searchRoot, targetDirectory);
    const candidates: CandidateInstructionFile[] = [];

    for (const directory of directories) {
      throwIfAborted(signal);
      const instructionPath = await this.findFirstInstructionFile(directory, signal);
      if (instructionPath !== undefined) {
        candidates.push({
          path: instructionPath,
          source: directory === searchRoot ? "project" : "subtree",
        });
      }
    }

    return candidates;
  }

  private async findFirstInstructionFile(directory: string, signal: AbortSignal | undefined): Promise<string | undefined> {
    for (const fileName of this.instructionFileNames) {
      throwIfAborted(signal);
      const candidate = join(directory, fileName);
      try {
        const fileStat = await stat(candidate);
        if (fileStat.isFile()) {
          return candidate;
        }
      } catch {
        continue;
      }
    }

    return undefined;
  }

  private async loadInstructionFile(
    candidatePath: string,
    signal: AbortSignal | undefined,
  ): Promise<CachedInstructionFile | undefined> {
    throwIfAborted(signal);

    let fileStat;
    try {
      fileStat = await stat(candidatePath);
    } catch {
      return undefined;
    }

    if (!fileStat.isFile()) {
      return undefined;
    }

    const realPath = await safeRealpath(candidatePath);
    const cached = this.contentCache.get(realPath);
    if (cached !== undefined && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
      this.cacheHits += 1;
      return cached;
    }

    const rawContent = await readFile(candidatePath, { encoding: "utf8", signal });
    const parsed = parseInstructionFile(rawContent);
    const cachedFile: CachedInstructionFile = {
      path: candidatePath,
      realPath,
      body: parsed.body,
      globs: parsed.globs,
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      lineCount: lineCount(parsed.body),
    };

    this.filesRead += 1;
    this.contentCache.set(realPath, cachedFile);
    return cachedFile;
  }
}

export { DEFAULT_INSTRUCTION_FILE_NAMES };

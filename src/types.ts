export type InstructionSource = "project" | "subtree";

export interface CollectorOptions {
  instructionFileNames?: readonly string[];
  maxBytesPerFile?: number;
  maxBytesPerResult?: number;
}

export interface CollectForReadInput {
  requestedPath: string;
  cwd: string;
  signal?: AbortSignal | undefined;
}

export interface InstructionDiscovery {
  path: string;
  realPath: string;
  displayPath: string;
  source: InstructionSource;
  content: string;
  lineCount: number;
  truncated: boolean;
  versionKey: string;
}

export interface CacheStats {
  cacheEntries: number;
  cacheHits: number;
  filesRead: number;
  announcedInstructionVersions: number;
}

export interface ParsedInstructionFile {
  body: string;
  globs: readonly string[];
}

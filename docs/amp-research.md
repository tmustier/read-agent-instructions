# Amp guidance-file research

This package was built after inspecting Amp's current public manual and the npm package `@sourcegraph/amp@0.0.1780703129-g28d71e`.

## Manual behavior

Amp documents `AGENTS.md` as durable project guidance. The important behavior for this Pi package is:

1. `AGENTS.md` in the current working directory, editor workspace roots, and parent directories are included automatically.
2. Subtree `AGENTS.md` files are included when the agent reads a file in that subtree.
3. If `AGENTS.md` is absent, Amp falls back to `AGENT.md` and `CLAUDE.md`.
4. Large repositories are expected to use a general top-level `AGENTS.md` plus more specific subtree files.
5. YAML frontmatter `globs` can restrict guidance to matching files.

## Npm implementation notes

The npm package ships a bundled `dist/main.js`, so names are minified. The relevant code paths are still visible:

1. The guidance filename priority list is `AGENTS.md`, case variants, `AGENT.md`, case variants, then `CLAUDE.md`.
2. Startup guidance discovery builds a set from workspace roots, parent directories, user config directories, and system config directories.
3. Subtree guidance discovery derives directories from files already read in the thread.
4. The per-file discovery function walks from the read file's directory back to the project root, finds the first supported guidance filename in each directory, filters out files already discovered in the thread, and returns `discoveredGuidanceFiles` entries with `uri`, `lineCount`, and `content`.
5. Amp adds `discoveredGuidanceFiles` to read, search/list, create, edit, and patch results. A later transport layer can strip the guidance payload from the visible tool result object and ship it as guidance content, but it originates from the tool result path.
6. Amp parses YAML frontmatter, supports `globs`, and recursively resolves `@file` mentions from guidance files. This Pi package implements the adjacent/ancestor file behavior and simple `globs`; it intentionally leaves recursive `@` mention expansion as future work.

## Pi mapping

Pi exposes a `tool_result` extension hook that can modify built-in tool results without creating extra model-visible tool calls. That is the closest public extension point to Amp's behavior.

This package uses that hook for successful `read` results:

1. Resolve the read path relative to Pi's `ctx.cwd`.
2. Find the nearest Git root, or fall back to `ctx.cwd` when the target is inside it.
3. Walk from that root to the read file's directory.
4. In each directory, use Amp-compatible filename priority and only keep the first match.
5. Cache content by real path, mtime, and size.
6. Deduplicate already-announced instruction file versions so repeated reads do not spam the agent.
7. Append a single `<agent-instructions>` text block to the same tool result content.

This keeps the behavior inside the existing read tool result payload and avoids additional tool-call chatter.

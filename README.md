# read-agent-instructions

`read-agent-instructions` is an MIT-licensed Pi package that automatically appends nearby `AGENTS.md`-style guidance to successful Pi `read` tool results.

It is inspired by Amp's behavior: when an agent reads a file inside a subtree, the matching project and subtree instruction files are included in the same tool result payload, without making the model issue extra visible tool calls.

## Install

From npm, after publication:

```bash
pi install npm:read-agent-instructions
```

From GitHub:

```bash
pi install git:github.com/tmustier/read-agent-instructions
```

For local development or a one-off test:

```bash
git clone https://github.com/tmustier/read-agent-instructions.git
cd read-agent-instructions
npm install
pi -e ./src/index.ts
```

## What it does

When Pi's built-in `read` tool successfully reads a file, the extension:

1. Resolves the read file relative to Pi's current working directory.
2. Finds the nearest Git root, or falls back to the current working directory when no Git root is present.
3. Walks from that root down to the file's directory.
4. Looks for one instruction file per directory, using Amp-compatible priority: `AGENTS.md`, `Agents.md`, `agents.md`, `AGENT.md`, `Agent.md`, `agent.md`, then `CLAUDE.md`.
5. Appends newly relevant instruction text to the same read tool result as a `<agent-instructions>` block.

More specific subtree files appear after broader project files, so later guidance can override earlier guidance when they conflict.

## Spam avoidance and caching

The extension avoids repeated context spam by:

1. Deduplicating instruction files within a single result by real path.
2. Remembering instruction file versions that have already been appended in the current Pi extension instance.
3. Re-announcing a file only when its mtime or size changes.
4. Caching file contents by real path, mtime, and size.
5. Truncating instruction content to bounded per-file and per-result byte limits.
6. Respecting simple YAML frontmatter `globs` or `paths` filters.

## Example

With this tree:

```text
workspace/
  repoA/
    .git/
    AGENTS.md
    packages/api/AGENTS.md
    packages/api/src/handler.ts
  repoB/
    .git/
    AGENTS.md
    app/src/main.ts
```

If the agent reads `repoA/packages/api/src/handler.ts`, the read result includes `repoA/AGENTS.md` and `repoA/packages/api/AGENTS.md`. A later read of `repoB/app/src/main.ts` includes `repoB/AGENTS.md`, not Repo A's instructions.

## Verify locally

```bash
npm install
npm run check
```

Run the representative tool-result harness:

```bash
npm run verify
```

Run the same harness inside tmux for end-to-end proof without relying only on unit tests:

```bash
tmux new-session -d -s rai-verify 'cd /path/to/read-agent-instructions && npm run verify:tmux > /tmp/rai-verify.log 2>&1; tmux wait-for -S rai-verify-done'
tmux wait-for rai-verify-done
cat /tmp/rai-verify.log
```

The repository's verification command used during development writes `TMUX_PROOF ...=true` lines showing that Repo A root/subtree instructions appear, repeated reads do not repeat them, and Repo B is isolated from Repo A.

## Development

```bash
npm run typecheck
npm test
npm run verify
```

The TypeScript configuration is strict. The source avoids `any`, casts, non-null assertions, and TypeScript suppression comments.

## Research notes

See `docs/amp-research.md` for the Amp manual and npm-source findings that shaped the implementation.

## Limitations

This package currently implements adjacent and ancestor instruction discovery plus simple frontmatter `globs`. Amp also recursively expands `@file` mentions inside guidance files; that is documented as future work here rather than guessed into the first release.

## License

MIT

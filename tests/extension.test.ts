import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import readAgentInstructions from "../src/index.ts";

type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>;

function loadToolResultHandler(): Handler {
  let handler: Handler | undefined;
  const pi = {
    on(event: string, fn: Handler) {
      if (event === "tool_result") handler = fn;
    },
    registerCommand() {},
  };
  readAgentInstructions(pi as never);
  assert.ok(handler);
  return handler;
}

function readResult(path: string, parentToolCallId?: string): Record<string, unknown> {
  return {
    type: "tool_result",
    toolName: "read",
    toolCallId: parentToolCallId === undefined ? "call-1" : `${parentToolCallId}/1`,
    ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
    input: { path },
    content: [{ type: "text", text: "export const value = 1;\n" }],
    isError: false,
    details: undefined,
  };
}

test("leaves reads made by another tool untouched and still announces on the next direct read", async () => {
  const repo = await mkdtemp(join(tmpdir(), "read-agent-instructions-nested-"));
  await mkdir(join(repo, ".git"));
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "AGENTS.md"), "Repo rule.", "utf8");
  const file = join(repo, "src", "file.ts");
  await writeFile(file, "export const value = 1;\n", "utf8");

  const handler = loadToolResultHandler();
  const ctx = { cwd: repo, signal: undefined };

  assert.equal(await handler(readResult(file, "codemode-call"), ctx), undefined);

  const direct = (await handler(readResult(file), ctx)) as { content: Array<{ text: string }> } | undefined;
  assert.ok(direct);
  assert.match(direct.content.at(-1)?.text ?? "", /Repo rule\./);
});

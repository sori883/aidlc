import { resolve } from "node:path";
import { runSensorFireHook } from "../hooks/aidlc-sensor-fire.ts";

export interface CodexPostToolUsePayload {
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: {
    command?: string;
    file_path?: string;
    path?: string;
  };
}

const PATCH_PATH_LINE = /^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm;

function patchPaths(command: string): string[] {
  return [...new Set(
    [...command.matchAll(PATCH_PATH_LINE)]
      .map((match) => match[1]?.trim())
      .filter((path): path is string => path !== undefined && path.length > 0),
  )];
}

export async function run(input: string): Promise<number> {
  try {
    const payload = JSON.parse(input || "{}") as CodexPostToolUsePayload;
    if (payload.hook_event_name !== "PostToolUse") return 0;
    const projectDir = resolve(
      process.env.CODEX_PROJECT_DIR ?? payload.cwd ?? process.cwd(),
    );
    const directPath = payload.tool_input?.file_path ?? payload.tool_input?.path;
    const files = directPath === undefined
      ? patchPaths(payload.tool_input?.command ?? "")
      : [directPath];
    const toolName = payload.tool_name === "apply_patch"
      ? "Write"
      : payload.tool_name ?? "";
    for (const file of files) {
      await runSensorFireHook(projectDir, {
        tool_name: toolName,
        tool_input: { file_path: file },
      });
    }
  } catch {
    // Codex Sensors are advisory and never block the originating edit.
  }
  return 0;
}

async function readStdin(): Promise<string> {
  let source = "";
  for await (const chunk of process.stdin) source += String(chunk);
  return source;
}

export async function main(_argv: string[]): Promise<void> {
  process.exitCode = await run(await readStdin());
}

if (import.meta.main) void main(process.argv.slice(2));

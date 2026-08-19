// Integrated CLI composition bridge. The Core router delegates to a generic
// hook entry; the selected release Adapter supplies the external payload map.

import { main as runCodexHookAdapter } from "../../harness/codex/hooks/aidlc-sensor-fire.ts";

export async function main(argv: string[]): Promise<void> {
  await runCodexHookAdapter(argv);
}

if (import.meta.main) void main(process.argv.slice(2));

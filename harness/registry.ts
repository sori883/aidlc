import {
  resolveHarnessDescriptor,
  type HarnessDescriptor,
} from "../core/tools/aidlc-harness-contract.ts";
import { CODEX_HARNESS } from "./codex/aidlc-harness.ts";

/** Concrete Adapters shipped by this release. */
export const SUPPORTED_HARNESSES: readonly HarnessDescriptor[] = [CODEX_HARNESS];

export function resolveSupportedHarness(id: string): HarnessDescriptor {
  return resolveHarnessDescriptor(id, SUPPORTED_HARNESSES);
}

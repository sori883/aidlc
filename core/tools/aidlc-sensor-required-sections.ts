import { runSensorCheckerCli } from "./aidlc-sensor-checkers.ts";

export function main(argv: string[]): void {
  runSensorCheckerCli("required-sections", argv);
}

if (import.meta.main) main(process.argv.slice(2));

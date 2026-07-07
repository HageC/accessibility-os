#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { baselineFingerprints, runScan, type Severity } from "./scan.js";

const usage = `AccessibilityOS scan CLI
Usage: corepack pnpm --filter @aos/cli aos --project <uuid> [options]

Options:
  --api <url>          API base URL (default http://127.0.0.1:4000/api/v1)
  --baseline <file>    Previous version 1 JSON report
  --output <file>      Save the current JSON report
  --fail-on <level>    none|minor|moderate|serious|critical (default none)
  --timeout-ms <n>    Maximum scan wait, 1000–600000 (default 90000)
  --help              Show this help

Exit codes: 0 passed, 1 threshold reached, 2 operational error. Use synthetic local targets only.`;

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`Missing value for ${name}`);
  return value;
}

async function main(args: string[]): Promise<void> {
  if (args.includes("--help")) {
    console.log(usage);
    return;
  }
  const allowed = new Set([
    "--project",
    "--api",
    "--baseline",
    "--output",
    "--fail-on",
    "--timeout-ms",
  ]);
  for (let index = 0; index < args.length; index += 2)
    if (!allowed.has(args[index] ?? "") || !args[index + 1])
      throw new Error(`Unknown or incomplete option: ${args[index] ?? ""}`);
  const projectId = option(args, "--project");
  if (
    !projectId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      projectId,
    )
  )
    throw new Error("--project requires a UUID");
  const apiUrl = option(args, "--api") ?? "http://127.0.0.1:4000/api/v1";
  const parsedApi = new URL(apiUrl);
  if (
    !["http:", "https:"].includes(parsedApi.protocol) ||
    parsedApi.username ||
    parsedApi.password
  )
    throw new Error("--api requires an HTTP(S) URL without credentials");
  const failOn = option(args, "--fail-on") ?? "none";
  if (!["none", "minor", "moderate", "serious", "critical"].includes(failOn))
    throw new Error("Invalid --fail-on level");
  const timeoutMs = Number(option(args, "--timeout-ms") ?? 90000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000)
    throw new Error("--timeout-ms must be between 1000 and 600000");
  const baselinePath = option(args, "--baseline");
  const baseline = baselinePath
    ? baselineFingerprints(
        JSON.parse(await readFile(baselinePath, "utf8")) as unknown,
      )
    : undefined;
  const result = await runScan({
    apiUrl,
    projectId,
    timeoutMs,
    failOn: failOn as Severity,
    baselineFingerprints: baseline,
  });
  const output = option(args, "--output");
  if (output)
    await writeFile(
      output,
      JSON.stringify(result.report, null, 2) + "\n",
      "utf8",
    );
  console.log(
    `Scan ${result.scanId}: ${result.report.summary.findingCount} finding(s), ${result.newFindings.length} new fingerprint(s).`,
  );
  if (result.shouldFail) {
    console.error(`New findings meet the ${failOn} threshold.`);
    process.exitCode = 1;
  }
}

main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : "Unknown CLI error");
  process.exitCode = 2;
});

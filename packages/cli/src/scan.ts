import type { ReportFinding, ScanReport } from "@aos/report-engine";

export type Severity = "none" | "minor" | "moderate" | "serious" | "critical";
export interface ScanOptions {
  apiUrl: string;
  projectId: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  failOn: Severity;
  baselineFingerprints?: Set<string>;
}
export interface ScanOutcome {
  scanId: string;
  report: ScanReport;
  newFindings: ReportFinding[];
  shouldFail: boolean;
}

const severityRank: Record<Severity, number> = {
  none: 0,
  minor: 1,
  moderate: 2,
  serious: 3,
  critical: 4,
};

export function baselineFingerprints(input: unknown): Set<string> {
  if (
    typeof input !== "object" ||
    input === null ||
    !("schemaVersion" in input) ||
    input.schemaVersion !== 1 ||
    !("pages" in input) ||
    !Array.isArray(input.pages)
  )
    throw new Error("Baseline must be a version 1 AccessibilityOS JSON report");
  const result = new Set<string>();
  for (const page of input.pages) {
    if (
      typeof page !== "object" ||
      page === null ||
      !("findings" in page) ||
      !Array.isArray(page.findings)
    )
      throw new Error("Baseline contains an invalid page");
    for (const finding of page.findings) {
      if (
        typeof finding !== "object" ||
        finding === null ||
        !("fingerprint" in finding) ||
        typeof finding.fingerprint !== "string"
      )
        throw new Error("Baseline contains an invalid finding fingerprint");
      result.add(finding.fingerprint);
    }
  }
  return result;
}

export function compareFindings(
  report: ScanReport,
  baseline = new Set<string>(),
): ReportFinding[] {
  const seen = new Set<string>();
  const result: ReportFinding[] = [];
  for (const page of report.pages)
    for (const finding of page.findings) {
      if (baseline.has(finding.fingerprint) || seen.has(finding.fingerprint))
        continue;
      seen.add(finding.fingerprint);
      result.push(finding);
    }
  return result;
}

async function jsonRequest(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok)
    throw new Error(
      `API request failed (${response.status}) at ${new URL(url).pathname}`,
    );
  return response.json() as Promise<unknown>;
}

export async function runScan(options: ScanOptions): Promise<ScanOutcome> {
  const api = options.apiUrl.replace(/\/$/, "");
  const started = await jsonRequest(
    `${api}/projects/${options.projectId}/scans`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
  );
  if (
    typeof started !== "object" ||
    started === null ||
    !("id" in started) ||
    typeof started.id !== "string"
  )
    throw new Error("API did not return a scan ID");
  const scanId = started.id;
  const deadline = Date.now() + options.timeoutMs;
  let completed = false;
  while (Date.now() < deadline) {
    const state = await jsonRequest(`${api}/scans/${scanId}`);
    if (
      typeof state !== "object" ||
      state === null ||
      !("status" in state) ||
      typeof state.status !== "string"
    )
      throw new Error("API returned an invalid scan state");
    if (state.status === "COMPLETED") {
      completed = true;
      break;
    }
    if (["FAILED", "TIMED_OUT"].includes(state.status))
      throw new Error(`Scan ${scanId} ${state.status.toLowerCase()}`);
    if (!["QUEUED", "RUNNING"].includes(state.status))
      throw new Error(`Scan ${scanId} has unknown state ${state.status}`);
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.min(
          options.pollIntervalMs ?? 1000,
          Math.max(0, deadline - Date.now()),
        ),
      ),
    );
  }
  if (!completed)
    throw new Error(
      `Scan ${scanId} did not complete within ${options.timeoutMs}ms`,
    );
  const report = await jsonRequest(`${api}/scans/${scanId}/report.json`);
  if (
    typeof report !== "object" ||
    report === null ||
    !("schemaVersion" in report) ||
    report.schemaVersion !== 1 ||
    !("pages" in report) ||
    !Array.isArray(report.pages)
  )
    throw new Error("API returned an invalid report");
  const newFindings = compareFindings(
    report as ScanReport,
    options.baselineFingerprints,
  );
  const shouldFail =
    options.failOn !== "none" &&
    newFindings.some(
      (finding) =>
        severityRank[(finding.impact ?? "none") as Severity] >=
        severityRank[options.failOn],
    );
  return { scanId, report: report as ScanReport, newFindings, shouldFail };
}

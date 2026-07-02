export interface AnalyticsScanInput {
  id: string;
  createdAt: Date | string;
  startedAt: Date | string | null;
  completedAt: Date | string | null;
  pages: { findings: { fingerprint: string; impact: string | null }[] }[];
}

export interface ScanTrendPoint {
  scanId: string;
  completedAt: string;
  durationMs: number | null;
  findingCount: number;
  uniqueFindingCount: number;
  newFindingCount: number;
  resolvedFindingCount: number;
  byImpact: Record<string, number>;
}

export interface ProjectAnalytics {
  completedScansConsidered: number;
  latest: ScanTrendPoint | null;
  trend: ScanTrendPoint[];
  limitations: string[];
}

export function buildProjectAnalytics(
  scans: AnalyticsScanInput[],
): ProjectAnalytics {
  const ordered = [...scans].sort(
    (a, b) =>
      new Date(a.completedAt ?? a.createdAt).getTime() -
        new Date(b.completedAt ?? b.createdAt).getTime() ||
      a.id.localeCompare(b.id),
  );
  let previous = new Set<string>();
  const trend = ordered.map((scan) => {
    const fingerprints = new Set<string>();
    const impacts = new Map<string, number>();
    let findingCount = 0;
    for (const page of scan.pages)
      for (const finding of page.findings) {
        fingerprints.add(finding.fingerprint);
        const impact = finding.impact ?? "unknown";
        impacts.set(impact, (impacts.get(impact) ?? 0) + 1);
        findingCount += 1;
      }
    const newFindingCount = [...fingerprints].filter(
      (fingerprint) => !previous.has(fingerprint),
    ).length;
    const resolvedFindingCount = [...previous].filter(
      (fingerprint) => !fingerprints.has(fingerprint),
    ).length;
    previous = fingerprints;
    const durationMs =
      scan.startedAt && scan.completedAt
        ? Math.max(
            0,
            new Date(scan.completedAt).getTime() -
              new Date(scan.startedAt).getTime(),
          )
        : null;
    return {
      scanId: scan.id,
      completedAt: new Date(scan.completedAt ?? scan.createdAt).toISOString(),
      durationMs,
      findingCount,
      uniqueFindingCount: fingerprints.size,
      newFindingCount,
      resolvedFindingCount,
      byImpact: Object.fromEntries(impacts),
    };
  });
  return {
    completedScansConsidered: trend.length,
    latest: trend.at(-1) ?? null,
    trend,
    limitations: [
      "Trend counts reflect automated findings from the most recent completed scans only.",
      "New and resolved counts use selector-based fingerprints and may change when the DOM changes.",
      "No metric in this response certifies WCAG compliance.",
    ],
  };
}

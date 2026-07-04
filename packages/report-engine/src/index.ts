export interface ReportFinding {
  id: string;
  fingerprint: string;
  ruleId: string;
  impact: string | null;
  description: string;
  help: string;
  helpUrl: string;
  target: string[];
  html: string;
  failureSummary: string | null;
  tags: string[];
  wcag: string[];
}

export interface ReportPage {
  url: string;
  title: string | null;
  findings: ReportFinding[];
}

export interface ScanReport {
  schemaVersion: 1;
  scanId: string;
  projectName: string;
  targetUrl: string;
  startedAt: string | null;
  completedAt: string;
  summary: {
    pageCount: number;
    findingCount: number;
    byImpact: Record<string, number>;
  };
  pages: ReportPage[];
  artifacts: { id: string; kind: string; mimeType: string }[];
  limitations: string[];
}

export function createScanReport(
  input: Omit<ScanReport, "schemaVersion" | "summary" | "limitations">,
): ScanReport {
  const impactCounts = new Map<string, number>();
  let findingCount = 0;
  for (const page of input.pages)
    for (const finding of page.findings) {
      const impact = finding.impact ?? "unknown";
      impactCounts.set(impact, (impactCounts.get(impact) ?? 0) + 1);
      findingCount += 1;
    }
  return {
    schemaVersion: 1,
    ...input,
    summary: {
      pageCount: input.pages.length,
      findingCount,
      byImpact: Object.fromEntries(impactCounts),
    },
    limitations: [
      "Automated findings do not prove WCAG compliance.",
      "This report covers only pages and interactions recorded in this scan.",
      "Context-dependent barriers and assistive technology behavior require human testing.",
    ],
  };
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

export function renderScanHtml(report: ScanReport): string {
  const e = escapeHtml;
  const pages = report.pages
    .map(
      (page) =>
        `<section><h2>${e(page.title || page.url)}</h2><p class="sub">${e(page.url)}</p>${page.findings.length ? page.findings.map((finding) => `<article><div class="finding-head"><span class="impact">${e(finding.impact ?? "unknown")}</span><h3>${e(finding.help)}</h3></div><p>${e(finding.description)}</p><dl><dt>Rule</dt><dd>${e(finding.ruleId)}</dd><dt>Fingerprint</dt><dd><code>${e(finding.fingerprint)}</code></dd><dt>WCAG tags from axe</dt><dd>${finding.wcag.length ? finding.wcag.map(e).join(", ") : "None supplied"}</dd><dt>Target</dt><dd><code>${e(finding.target.join(", "))}</code></dd><dt>Failure summary</dt><dd>${e(finding.failureSummary ?? "None supplied")}</dd><dt>Rule guidance</dt><dd>${e(finding.helpUrl)}</dd></dl><h4>Captured DOM</h4><pre>${e(finding.html)}</pre></article>`).join("") : "<p>No automated findings were recorded on this page.</p>"}</section>`,
    )
    .join("");
  const artifactList = report.artifacts
    .map(
      (artifact) =>
        `<li>${e(artifact.kind)}: ${e(artifact.id)} (${e(artifact.mimeType)})</li>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>AccessibilityOS report - ${e(report.projectName)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:960px;margin:auto;padding:2rem;color:#17252d;background:#fff}h1{font-size:2.3rem}h2{border-bottom:2px solid #bed9d5;padding-bottom:.4rem;margin-top:3rem}h3{margin:0}.sub{overflow-wrap:anywhere;color:#455e66}article{border:1px solid #b9cbd0;border-radius:10px;padding:1.25rem;margin:1rem 0}.finding-head{display:flex;gap:1rem;align-items:center}.impact{font-weight:700;text-transform:uppercase;background:#e9f2ef;border-radius:2rem;padding:.25rem .6rem;font-size:.75rem}dt{font-weight:700;margin-top:.8rem}dd{margin:0;overflow-wrap:anywhere}pre{overflow:auto;white-space:pre-wrap;word-break:break-word;background:#f0f5f5;padding:1rem;border-radius:6px}code{overflow-wrap:anywhere}.notice{padding:1rem;background:#fff4db;border-left:4px solid #8e6b1f}a:focus-visible{outline:3px solid #087d70}</style></head><body><header><p>AccessibilityOS / automated evidence</p><h1>${e(report.projectName)}</h1><p class="sub">${e(report.targetUrl)}</p><p>Scan ${e(report.scanId)} · Completed ${e(report.completedAt)}</p></header><main><div class="notice"><strong>Interpretation limits</strong><ul>${report.limitations.map((limit) => `<li>${e(limit)}</li>`).join("")}</ul></div><section><h2>Summary</h2><p>${report.summary.pageCount} page(s), ${report.summary.findingCount} finding(s)</p><ul>${Object.entries(
    report.summary.byImpact,
  )
    .map(([impact, count]) => `<li>${e(impact)}: ${count}</li>`)
    .join(
      "",
    )}</ul></section>${pages}<section><h2>Artifact references</h2><ul>${artifactList}</ul></section></main></body></html>`;
}

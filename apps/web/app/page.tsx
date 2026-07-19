"use client";

import { useEffect, useRef, useState } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { FocusExplorer, type FocusObservation } from "./focus-explorer";
import { JourneyStudio } from "./journey-studio";
import { AnalyticsPanel } from "./analytics-panel";

const API = "http://127.0.0.1:4000/api/v1";
const projectSchema = z.object({
  name: z.string().min(2, "Enter at least two characters"),
  url: z.string().url("Enter a valid URL"),
});
type ProjectInput = z.infer<typeof projectSchema>;
type Scan = {
  id: string;
  status: string;
  createdAt: string;
  failureText: string | null;
  pages?: { url: string; title: string | null; _count: { findings: number } }[];
  artifacts?: { id: string; kind: string }[];
};
type Project = { id: string; name: string; url: string; scans: Scan[] };
type Finding = {
  id: string;
  ruleId: string;
  impact: string | null;
  help: string;
  description: string;
  html: string;
  failureSummary: string | null;
  target: string[];
  wcag: string[];
  helpUrl: string;
  page: {
    url: string;
    artifacts?: { id: string; kind: string }[];
    scan?: { targetUrl: string; artifacts: { id: string; kind: string }[] };
  };
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error?.message ?? "Request failed");
  }
  return response.json() as Promise<T>;
}

function Dashboard() {
  const client = useQueryClient();
  const [activeScan, setActiveScan] = useState<string | null>(null);
  const [activeFinding, setActiveFinding] = useState<string | null>(null);
  const findingDialogRef = useRef<HTMLDialogElement>(null);
  const [findingCursors, setFindingCursors] = useState<(string | null)[]>([
    null,
  ]);
  const [findingPage, setFindingPage] = useState(0);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projectSearch, setProjectSearch] = useState("");
  const [projectPage, setProjectPage] = useState(1);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(
    null,
  );
  const [projectNotice, setProjectNotice] = useState("");
  const [maxPages, setMaxPages] = useState(8);
  const [maxDepth, setMaxDepth] = useState(2);
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => request<Project[]>("/projects"),
    refetchInterval: 5000,
  });
  const configuration = useQuery({
    queryKey: ["configuration"],
    queryFn: () => request<{ defaultTargetUrl: string }>("/config"),
    staleTime: Infinity,
  });
  const scan = useQuery({
    queryKey: ["scan", activeScan],
    queryFn: () => request<Scan>(`/scans/${activeScan}`),
    enabled: !!activeScan,
    refetchInterval: (query) =>
      ["QUEUED", "RUNNING"].includes(query.state.data?.status ?? "")
        ? 1500
        : false,
  });
  const findings = useQuery({
    queryKey: ["findings", activeScan, findingCursors[findingPage]],
    queryFn: () =>
      request<{ items: Finding[]; nextCursor: string | null }>(
        `/scans/${activeScan}/findings?limit=10${findingCursors[findingPage] ? `&cursor=${findingCursors[findingPage]}` : ""}`,
      ),
    enabled: !!activeScan && scan.data?.status === "COMPLETED",
  });
  useEffect(() => {
    setFindingCursors([null]);
    setFindingPage(0);
  }, [activeScan]);
  const focus = useQuery({
    queryKey: ["focus", activeScan],
    queryFn: () => request<FocusObservation[]>(`/scans/${activeScan}/focus`),
    enabled: !!activeScan && scan.data?.status === "COMPLETED",
  });
  const detail = useQuery({
    queryKey: ["finding", activeFinding],
    queryFn: () =>
      request<
        Finding & {
          page: {
            artifacts: { id: string; kind: string }[];
            scan: {
              targetUrl: string;
              artifacts: { id: string; kind: string }[];
            };
          };
        }
      >(`/findings/${activeFinding}`),
    enabled: !!activeFinding,
  });
  useEffect(() => {
    if (!activeFinding) return;
    const dialog = findingDialogRef.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
    };
  }, [activeFinding]);
  const form = useForm<ProjectInput>({
    resolver: zodResolver(projectSchema),
    defaultValues: { name: "", url: "http://127.0.0.1:3000/fixture.html" },
  });
  useEffect(() => {
    if (configuration.data?.defaultTargetUrl && !form.formState.dirtyFields.url)
      form.setValue("url", configuration.data.defaultTargetUrl);
  }, [
    configuration.data?.defaultTargetUrl,
    form,
    form.formState.dirtyFields.url,
  ]);
  const create = useMutation({
    mutationFn: (values: ProjectInput) =>
      request<Project>("/projects", {
        method: "POST",
        body: JSON.stringify(values),
      }),
    onSuccess: () => {
      form.reset();
      setProjectPage(1);
      setProjectSearch("");
      void client.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  const removeProject = useMutation({
    mutationFn: (projectId: string) =>
      request<{ deleted: boolean }>(`/projects/${projectId}`, {
        method: "DELETE",
      }),
    onSuccess: (_result, projectId) => {
      client.setQueryData<Project[]>(["projects"], (current) =>
        current?.filter((project) => project.id !== projectId),
      );
      void client.invalidateQueries({ queryKey: ["projects"] });
      if (activeProjectId === projectId) {
        setActiveProjectId(null);
        setActiveScan(null);
        setActiveFinding(null);
      }
      setDeletingProjectId(null);
      setProjectNotice("Project and its saved evidence deleted.");
    },
  });
  const start = useMutation({
    mutationFn: (projectId: string) =>
      request<Scan>(`/projects/${projectId}/scans`, {
        method: "POST",
        body: JSON.stringify({ maxPages, maxDepth }),
      }),
    onSuccess: (data, projectId) => {
      setActiveProjectId(projectId);
      setActiveFinding(null);
      setActiveScan(data.id);
      void client.invalidateQueries({ queryKey: ["projects"] });
    },
  });
  useEffect(() => {
    if (scan.data && !["QUEUED", "RUNNING"].includes(scan.data.status))
      void client.invalidateQueries({ queryKey: ["projects"] });
  }, [scan.data?.status, client]);
  const totalFindings =
    scan.data?.pages?.reduce((sum, page) => sum + page._count.findings, 0) ?? 0;
  const detailScreenshot =
    detail.data?.page.artifacts?.find((artifact) =>
      ["SCREENSHOT", "PAGE_SCREENSHOT"].includes(artifact.kind),
    ) ??
    (detail.data?.page.url === detail.data?.page.scan?.targetUrl
      ? detail.data?.page.scan?.artifacts.find(
          (artifact) => artifact.kind === "SCREENSHOT",
        )
      : undefined);
  const fixtureOrigin = new URL(
    configuration.data?.defaultTargetUrl ??
      "http://127.0.0.1:3000/fixture.html",
  ).origin;
  const filteredProjects = (projects.data ?? []).filter((project) =>
    `${project.name} ${project.url}`
      .toLocaleLowerCase()
      .includes(projectSearch.trim().toLocaleLowerCase()),
  );
  const projectPageCount = Math.max(1, Math.ceil(filteredProjects.length / 5));
  const visibleProjectPage = Math.min(projectPage, projectPageCount);
  const visibleProjects = filteredProjects.slice(
    (visibleProjectPage - 1) * 5,
    visibleProjectPage * 5,
  );

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">A</span>
          <span>
            Accessibility<span className="brand-accent">OS</span>
          </span>
        </div>
        <nav aria-label="Primary">
          <a className="nav-active" href="#overview">
            Overview
          </a>
          <a href="#projects">Projects</a>
          <a href="#results">Scan results</a>
          <a href="#analytics">Analytics</a>
          <a href="#journeys">Journeys</a>
        </nav>
      </aside>
      <main id="overview" className="main">
        <div className="content">
          <header className="page-header">
            <h1>Accessibility dashboard</h1>
            <p>Scan websites and review findings, evidence, and journeys.</p>
          </header>
          <section className="summary" aria-label="Workspace summary">
            <div>
              <span>PROJECTS</span>
              <strong>{projects.data?.length ?? "—"}</strong>
            </div>
            <div>
              <span>RECENT SCANS</span>
              <strong>
                {projects.data?.reduce((sum, p) => sum + p.scans.length, 0) ??
                  "—"}
              </strong>
            </div>
            <div>
              <span>CURRENT FINDINGS</span>
              <strong>{activeScan ? totalFindings : "—"}</strong>
            </div>
          </section>
          <div className="columns">
            <section className="panel" id="projects">
              <div className="panel-heading">
                <div>
                  <h2>Projects</h2>
                </div>
              </div>
              {projects.isLoading && (
                <p role="status" className="state">
                  Loading projects…
                </p>
              )}
              {projects.isError && (
                <div role="alert" className="state error">
                  Could not load projects.{" "}
                  <button onClick={() => void projects.refetch()}>
                    Try again
                  </button>
                </div>
              )}
              {projects.data?.length === 0 && (
                <p className="state">
                  No projects yet. Add a public HTTPS website below to begin.
                </p>
              )}
              <div className="scan-options" aria-label="Scan scope">
                <label htmlFor="max-pages">
                  Max pages
                  <select
                    id="max-pages"
                    value={maxPages}
                    onChange={(event) =>
                      setMaxPages(Number(event.target.value))
                    }
                  >
                    {[1, 5, 8, 12, 20, 50, 100].map((count) => (
                      <option key={count} value={count}>
                        {count}
                      </option>
                    ))}
                  </select>
                </label>
                <label htmlFor="max-depth">
                  Link depth
                  <select
                    id="max-depth"
                    value={maxDepth}
                    onChange={(event) =>
                      setMaxDepth(Number(event.target.value))
                    }
                  >
                    {[0, 1, 2, 3, 4, 5, 6].map((depth) => (
                      <option key={depth} value={depth}>
                        {depth}
                      </option>
                    ))}
                  </select>
                </label>
                <p>
                  Follow same-origin links and sitemap pages. Depth 0 checks the
                  starting page only.
                </p>
              </div>
              {(projects.data?.length ?? 0) > 0 && (
                <div className="project-tools">
                  <label htmlFor="project-search">Search projects</label>
                  <input
                    id="project-search"
                    type="search"
                    value={projectSearch}
                    onChange={(event) => {
                      setProjectSearch(event.target.value);
                      setProjectPage(1);
                    }}
                    placeholder="Name or URL"
                  />
                  <span>
                    {filteredProjects.length}{" "}
                    {filteredProjects.length === 1 ? "project" : "projects"}
                  </span>
                </div>
              )}
              {projects.data &&
                filteredProjects.length === 0 &&
                projects.data.length > 0 && (
                  <p className="state">No projects match your search.</p>
                )}
              {projectNotice && (
                <p role="status" className="project-notice">
                  {projectNotice}
                </p>
              )}
              {visibleProjects.map((project) => (
                <article className="project" key={project.id}>
                  <div className="project-head">
                    <div>
                      <h3>{project.name}</h3>
                      <p title={project.url}>{project.url}</p>
                    </div>
                  </div>
                  <div className="project-actions">
                    <button
                      onClick={() => start.mutate(project.id)}
                      disabled={start.isPending}
                    >
                      Start scan <span aria-hidden="true">↗</span>
                    </button>
                    {project.scans[0] && (
                      <button
                        className="text-button"
                        onClick={() => {
                          setActiveScan(project.scans[0]!.id);
                          setActiveProjectId(project.id);
                          setActiveFinding(null);
                        }}
                      >
                        View latest
                      </button>
                    )}
                    <button
                      className="delete-project-button"
                      type="button"
                      onClick={() => {
                        removeProject.reset();
                        setDeletingProjectId(project.id);
                        setProjectNotice("");
                      }}
                      aria-label={`Delete ${project.name}`}
                    >
                      Delete
                    </button>
                  </div>
                  {deletingProjectId === project.id && (
                    <div
                      className="delete-confirmation"
                      role="group"
                      aria-label={`Confirm deletion of ${project.name}`}
                    >
                      <p>
                        Delete <strong>{project.name}</strong> and all its
                        scans, findings, journeys, and screenshots?
                      </p>
                      <div>
                        <button
                          type="button"
                          className="delete-confirm-button"
                          disabled={removeProject.isPending}
                          onClick={() => removeProject.mutate(project.id)}
                        >
                          {removeProject.isPending
                            ? "Deleting…"
                            : "Delete project"}
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          disabled={removeProject.isPending}
                          onClick={() => setDeletingProjectId(null)}
                        >
                          Cancel
                        </button>
                      </div>
                      {removeProject.isError && (
                        <p role="alert" className="form-error">
                          {removeProject.error.message}
                        </p>
                      )}
                    </div>
                  )}
                </article>
              ))}
              {projectPageCount > 1 && (
                <nav className="project-pagination" aria-label="Project pages">
                  <button
                    type="button"
                    disabled={visibleProjectPage === 1}
                    onClick={() => setProjectPage(visibleProjectPage - 1)}
                  >
                    Previous
                  </button>
                  <span>
                    Page {visibleProjectPage} of {projectPageCount}
                  </span>
                  <button
                    type="button"
                    disabled={visibleProjectPage === projectPageCount}
                    onClick={() => setProjectPage(visibleProjectPage + 1)}
                  >
                    Next
                  </button>
                </nav>
              )}
              <form
                className="create-form"
                onSubmit={form.handleSubmit((values) => create.mutate(values))}
              >
                <h3>Add a project</h3>
                <label htmlFor="name">Project name</label>
                <input
                  id="name"
                  {...form.register("name")}
                  aria-invalid={!!form.formState.errors.name}
                />
                {form.formState.errors.name && (
                  <p className="form-error">
                    {form.formState.errors.name.message}
                  </p>
                )}
                <label htmlFor="url">Target URL</label>
                <input
                  id="url"
                  {...form.register("url")}
                  aria-invalid={!!form.formState.errors.url}
                />
                {form.formState.errors.url && (
                  <p className="form-error">
                    {form.formState.errors.url.message}
                  </p>
                )}
                <p className="form-hint">
                  Public HTTPS sites only. The sample fixture is prefilled.
                </p>
                <button type="submit" disabled={create.isPending}>
                  {create.isPending ? "Creating…" : "Create project"}
                </button>
                {create.isError && (
                  <p role="alert" className="form-error">
                    {create.error.message}
                  </p>
                )}
              </form>
              {start.isError && (
                <p role="alert" className="form-error">
                  {start.error.message}
                </p>
              )}
            </section>
            <section className="panel" id="results">
              <div className="panel-heading">
                <div>
                  <h2>Scan results</h2>
                </div>
                {scan.data && (
                  <span className={`badge ${scan.data.status.toLowerCase()}`}>
                    {scan.data.status}
                  </span>
                )}
              </div>
              {!activeScan && (
                <div className="empty">
                  <span aria-hidden="true">◇</span>
                  <h3>No scan selected</h3>
                  <p>
                    Start a scan or open a recent result to inspect the
                    evidence.
                  </p>
                </div>
              )}
              {scan.isLoading && (
                <p role="status" className="state">
                  Loading scan…
                </p>
              )}
              {scan.isError && (
                <div role="alert" className="state error">
                  Could not load scan.{" "}
                  <button onClick={() => void scan.refetch()}>Try again</button>
                </div>
              )}
              {scan.data && (
                <>
                  <div className="scan-meta">
                    <span>
                      SCAN ID <code>{scan.data.id.slice(0, 8)}</code>
                    </span>
                    <span>
                      FINDINGS <strong>{totalFindings}</strong>
                    </span>
                    <span>
                      PAGES <strong>{scan.data.pages?.length ?? 0}</strong>
                    </span>
                  </div>
                  {["QUEUED", "RUNNING"].includes(scan.data.status) && (
                    <p role="status" className="state">
                      {scan.data.status === "QUEUED"
                        ? "Waiting for the scan worker…"
                        : "Browser scan in progress…"}
                    </p>
                  )}
                  {["FAILED", "TIMED_OUT"].includes(scan.data.status) && (
                    <p role="alert" className="state error">
                      Scan did not complete:{" "}
                      {scan.data.failureText ?? scan.data.status}
                    </p>
                  )}
                  {scan.data.status === "COMPLETED" && (
                    <>
                      <details className="page-summary">
                        <summary>
                          Pages scanned ({scan.data.pages?.length ?? 0})
                        </summary>
                        <ol>
                          {scan.data.pages?.map((page) => (
                            <li key={page.url}>
                              <span>{page.title || page.url}</span>
                              <small>{page.url}</small>
                              <strong>{page._count.findings} findings</strong>
                            </li>
                          ))}
                        </ol>
                      </details>
                      <div
                        className="report-actions"
                        role="group"
                        aria-label="Export scan report"
                      >
                        <a href={`${API}/scans/${scan.data.id}/report.json`}>
                          Download JSON report
                        </a>
                        <a href={`${API}/scans/${scan.data.id}/report.html`}>
                          Download HTML report
                        </a>
                      </div>
                      {findings.isLoading && (
                        <p className="state">Loading findings…</p>
                      )}
                      {findings.isError && (
                        <p role="alert" className="state error">
                          Could not load findings.
                        </p>
                      )}
                      {findings.data?.items.length === 0 && (
                        <p className="state">
                          No automated findings on scanned pages. Manual testing
                          is still needed.
                        </p>
                      )}
                      <div className="finding-list">
                        {findings.data?.items.map((finding) => (
                          <button
                            key={finding.id}
                            className={
                              activeFinding === finding.id
                                ? "finding selected"
                                : "finding"
                            }
                            onClick={() => setActiveFinding(finding.id)}
                          >
                            <span
                              className={`severity ${finding.impact ?? "unknown"}`}
                            >
                              {finding.impact ?? "unknown"}
                            </span>
                            <span className="finding-copy">
                              <strong>{finding.help}</strong>
                              <small>
                                {finding.ruleId} · {finding.page.url}
                              </small>
                              <span
                                className="finding-action"
                                aria-hidden="true"
                              >
                                View evidence →
                              </span>
                            </span>
                          </button>
                        ))}
                      </div>
                      {findings.data && totalFindings > 10 && (
                        <nav
                          className="project-pagination"
                          aria-label="Finding pages"
                        >
                          <button
                            type="button"
                            disabled={findingPage === 0}
                            onClick={() => {
                              setFindingPage((page) => page - 1);
                              setActiveFinding(null);
                            }}
                          >
                            Previous
                          </button>
                          <span>
                            Page {findingPage + 1} of{" "}
                            {Math.ceil(totalFindings / 10)}
                          </span>
                          <button
                            type="button"
                            disabled={!findings.data.nextCursor}
                            onClick={() => {
                              const next = findings.data.nextCursor;
                              if (!next) return;
                              setFindingCursors((cursors) => [
                                ...cursors.slice(0, findingPage + 1),
                                next,
                              ]);
                              setFindingPage((page) => page + 1);
                              setActiveFinding(null);
                            }}
                          >
                            Next
                          </button>
                        </nav>
                      )}
                    </>
                  )}
                </>
              )}
            </section>
          </div>
          {scan.data?.status === "COMPLETED" && (
            <section
              className="panel focus-panel"
              id="focus"
              aria-label="Focus explorer"
            >
              <div className="panel-heading">
                <div>
                  <h2>Focus explorer</h2>
                </div>
                <span className="focus-count">
                  {focus.data?.length ?? 0} observed steps
                </span>
              </div>
              <p className="focus-description">
                Actual Tab and Shift+Tab transitions from a controlled browser
                run. Names and roles are best-effort DOM descriptions; use the
                sequence to investigate, not as an automatic WCAG verdict.
              </p>
              {focus.isLoading && (
                <p role="status" className="state">
                  Loading focus observations…
                </p>
              )}
              {focus.isError && (
                <div role="alert" className="state error">
                  Could not load focus observations.{" "}
                  <button onClick={() => void focus.refetch()}>
                    Try again
                  </button>
                </div>
              )}
              {focus.data?.length === 0 && (
                <p className="state">
                  No focus observations were recorded for this scan. Start a new
                  scan to capture them.
                </p>
              )}
              {focus.data && focus.data.length > 0 && (
                <>
                  <FocusExplorer
                    observations={focus.data}
                    artifacts={scan.data.artifacts ?? []}
                  />
                </>
              )}
            </section>
          )}
          {activeFinding && (
            <dialog
              className="finding-dialog detail"
              aria-labelledby="finding-dialog-title"
              ref={findingDialogRef}
              onClose={() => setActiveFinding(null)}
            >
              <div className="panel-heading">
                <div>
                  <h2 id="finding-dialog-title">Finding evidence</h2>
                </div>
                <button
                  className="text-button"
                  onClick={() => findingDialogRef.current?.close()}
                >
                  Close
                </button>
              </div>
              {detail.isLoading && <p className="state">Loading evidence…</p>}
              {detail.isError && (
                <p role="alert" className="state error">
                  Could not load finding details.
                </p>
              )}
              {detail.data && (
                <div className="detail-grid">
                  <div>
                    <span
                      className={`severity ${detail.data.impact ?? "unknown"}`}
                    >
                      {detail.data.impact ?? "unknown"}
                    </span>
                    <h3>{detail.data.help}</h3>
                    <p>{detail.data.description}</p>
                    <dl>
                      <dt>Rule</dt>
                      <dd>{detail.data.ruleId}</dd>
                      <dt>WCAG tags from axe</dt>
                      <dd>
                        {detail.data.wcag.length
                          ? detail.data.wcag.join(", ")
                          : "None supplied"}
                      </dd>
                      <dt>Target</dt>
                      <dd>
                        <code>{detail.data.target.join(", ")}</code>
                      </dd>
                      <dt>Failure summary</dt>
                      <dd>
                        {detail.data.failureSummary ?? "No summary supplied"}
                      </dd>
                    </dl>
                    <a
                      href={detail.data.helpUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Read rule guidance ↗
                    </a>
                  </div>
                  <div>
                    <h3>Captured element</h3>
                    <pre>{detail.data.html}</pre>
                    {detailScreenshot && (
                      <>
                        <h3>Page screenshot</h3>
                        <a
                          href={`${API}/artifacts/${detailScreenshot.id}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <img
                            alt="Captured page during accessibility scan"
                            src={`${API}/artifacts/${detailScreenshot.id}`}
                          />
                        </a>
                      </>
                    )}
                  </div>
                </div>
              )}
            </dialog>
          )}
          <AnalyticsPanel projects={projects.data ?? []} />
          <JourneyStudio
            projects={projects.data ?? []}
            fixtureOrigin={fixtureOrigin}
          />
          <footer>
            Automated findings are evidence, not a declaration of WCAG
            compliance.
          </footer>
        </div>
      </main>
    </div>
  );
}

const queryClient = new QueryClient();
export default function Page() {
  return (
    <QueryClientProvider client={queryClient}>
      <Dashboard />
    </QueryClientProvider>
  );
}

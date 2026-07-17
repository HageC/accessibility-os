"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

interface ProjectOption {
  id: string;
  name: string;
  url: string;
  session?: { updatedAt: string } | null;
}
interface JourneyRun {
  id: string;
  status: string;
  outcome: string | null;
  failureText: string | null;
  screenshotKey: string | null;
  stepResults: {
    id: string;
    sequence: number;
    action: string;
    outcome: string;
    expected: string | null;
    observed: string | null;
    failure: string | null;
    screenshotKey: string | null;
    auditFindings:
      | {
          ruleId: string;
          impact: string | null;
          help: string;
          target: string[];
        }[]
      | null;
  }[];
}
interface Journey {
  id: string;
  name: string;
  runs: JourneyRun[];
}
const API = "http://127.0.0.1:4000/api/v1";

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

function template(url: string, fixtureOrigin: string): string {
  if (new URL(url).origin !== fixtureOrigin)
    return JSON.stringify(
      {
        name: "Keyboard path",
        steps: [
          { action: "navigate", url },
          { action: "press", key: "Tab" },
          { action: "press", key: "Tab" },
          { action: "press", key: "Tab" },
        ],
      },
      null,
      2,
    );
  const fixture = new URL("/journey-fixture.html", url).toString();
  return JSON.stringify(
    {
      name: "Registration keyboard journey",
      steps: [
        { action: "navigate", url: fixture },
        { action: "focus", target: { role: "textbox", name: "Email" } },
        { action: "type", value: "synthetic@example.test" },
        { action: "press", key: "Tab" },
        {
          action: "assertFocus",
          target: { role: "textbox", name: "Password" },
        },
      ],
    },
    null,
    2,
  );
}

export function JourneyStudio({
  projects,
  fixtureOrigin,
}: {
  projects: ProjectOption[];
  fixtureOrigin: string;
}) {
  const client = useQueryClient();
  const [projectId, setProjectId] = useState("");
  const [specText, setSpecText] = useState("");
  const [runId, setRunId] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const selectedProject = projects.find((project) => project.id === projectId);
  useEffect(() => {
    if (!projects.some((project) => project.id === projectId)) {
      setProjectId(projects[0]?.id ?? "");
      setSpecText(projects[0] ? template(projects[0].url, fixtureOrigin) : "");
      setRunId(null);
    }
  }, [projectId, projects, fixtureOrigin]);
  const journeys = useQuery({
    queryKey: ["journeys", projectId],
    queryFn: () => request<Journey[]>(`/projects/${projectId}/journeys`),
    enabled: !!projectId,
  });
  const run = useQuery({
    queryKey: ["journey-run", runId],
    queryFn: () => request<JourneyRun>(`/journey-runs/${runId}`),
    enabled: !!runId,
    refetchInterval: (query) =>
      ["QUEUED", "RUNNING"].includes(query.state.data?.status ?? "")
        ? 1500
        : false,
  });
  const create = useMutation({
    mutationFn: (definition: unknown) =>
      request<Journey>(`/projects/${projectId}/journeys`, {
        method: "POST",
        body: JSON.stringify(definition),
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["journeys", projectId] });
    },
  });
  const start = useMutation({
    mutationFn: (journeyId: string) =>
      request<JourneyRun>(`/journeys/${journeyId}/runs`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: (result) => {
      setRunId(result.id);
      void client.invalidateQueries({ queryKey: ["journeys", projectId] });
    },
  });
  const clearSession = useMutation({
    mutationFn: () =>
      request<{ deleted: boolean }>(`/projects/${projectId}/session`, {
        method: "DELETE",
      }),
    onSuccess: () => void client.invalidateQueries({ queryKey: ["projects"] }),
  });
  useEffect(() => {
    if (run.data && !["QUEUED", "RUNNING"].includes(run.data.status)) {
      void client.invalidateQueries({ queryKey: ["journeys", projectId] });
      void client.invalidateQueries({ queryKey: ["projects"] });
    }
  }, [run.data?.status, client, projectId]);
  function appendStep(step: Record<string, unknown>) {
    try {
      const definition = JSON.parse(specText) as { steps?: unknown[] };
      if (!Array.isArray(definition.steps)) throw new Error();
      setSpecText(
        JSON.stringify(
          { ...definition, steps: [...definition.steps, step] },
          null,
          2,
        ),
      );
      setInputError(null);
    } catch {
      setInputError("Fix the journey JSON before adding a step.");
    }
  }
  function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      setInputError(null);
      create.mutate(JSON.parse(specText) as unknown);
    } catch {
      setInputError("Enter valid JSON before creating a journey.");
    }
  }
  return (
    <section
      className="panel journey-panel"
      id="journeys"
      aria-label="Journey Studio"
    >
      <div className="panel-heading">
        <div>
          <h2>Journey Studio</h2>
        </div>
      </div>
      <p className="focus-description">
        Record page navigation, clicks, form controls, keyboard focus, and
        automated audits in one browser session. Navigation stays on this
        project's origin. Use a test account for login journeys.
      </p>
      {projects.length === 0 ? (
        <p className="state">Add a project before creating a journey.</p>
      ) : (
        <>
          <form className="journey-form" onSubmit={handleCreate}>
            <label htmlFor="journey-project">Project</label>
            <select
              id="journey-project"
              value={projectId}
              onChange={(event) => {
                const selected = projects.find(
                  (project) => project.id === event.target.value,
                );
                setProjectId(event.target.value);
                if (selected)
                  setSpecText(template(selected.url, fixtureOrigin));
                setRunId(null);
              }}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            {selectedProject?.session && (
              <div className="journey-session">
                <span>Reusable login session saved for this project.</span>
                <button
                  type="button"
                  onClick={() => clearSession.mutate()}
                  disabled={clearSession.isPending}
                >
                  Clear session
                </button>
              </div>
            )}
            <label htmlFor="journey-definition">
              Journey definition (JSON)
            </label>
            <textarea
              id="journey-definition"
              rows={14}
              value={specText}
              onChange={(event) => setSpecText(event.target.value)}
              aria-describedby="journey-hint"
              spellCheck={false}
            />
            <div className="journey-presets">
              <button
                type="button"
                onClick={() =>
                  appendStep({ action: "audit", label: "Current page" })
                }
              >
                Add audit step
              </button>
              <button
                type="button"
                onClick={() => appendStep({ action: "saveSession" })}
              >
                Add save session step
              </button>
            </div>
            <p id="journey-hint" className="focus-description">
              The first step must navigate to this project's origin. To sign in,
              set AOS_JOURNEY_USERNAME and AOS_JOURNEY_PASSWORD in your local
              .env, restart the worker, then use fillSecret steps and a click
              step before saveSession. Secret values are not stored in the
              journey JSON.
            </p>
            <details className="journey-example">
              <summary>Login step example</summary>
              <pre>
                {JSON.stringify(
                  [
                    {
                      action: "fillSecret",
                      target: { role: "textbox", name: "Email" },
                      secret: "USERNAME",
                    },
                    {
                      action: "fillSecret",
                      target: { role: "textbox", name: "Password" },
                      secret: "PASSWORD",
                    },
                    {
                      action: "click",
                      target: { role: "button", name: "Sign in" },
                    },
                    {
                      action: "assertVisible",
                      target: { role: "link", name: "Account" },
                    },
                    { action: "saveSession" },
                    { action: "audit", label: "Signed-in page" },
                  ],
                  null,
                  2,
                )}
              </pre>
            </details>
            <button type="submit" disabled={create.isPending}>
              {create.isPending ? "Saving…" : "Save journey"}
            </button>
            {inputError && (
              <p role="alert" className="form-error">
                {inputError}
              </p>
            )}
            {create.isError && (
              <p role="alert" className="form-error">
                {create.error.message}
              </p>
            )}
            {create.isSuccess && (
              <p role="status" className="journey-success">
                Journey saved. Run it below.
              </p>
            )}
          </form>
          <div className="journey-list">
            <h3>Saved journeys</h3>
            {journeys.isLoading && (
              <p role="status" className="state">
                Loading journeys…
              </p>
            )}
            {journeys.isError && (
              <p role="alert" className="state error">
                Could not load journeys.{" "}
                <button onClick={() => void journeys.refetch()}>
                  Try again
                </button>
              </p>
            )}
            {journeys.data?.length === 0 && (
              <p className="state">No journeys saved for this project.</p>
            )}
            {journeys.data?.map((journey) => (
              <div className="journey-row" key={journey.id}>
                <div>
                  <strong>{journey.name}</strong>
                  <small>
                    {journey.runs[0]
                      ? `Latest: ${journey.runs[0].status}${journey.runs[0].outcome ? ` / ${journey.runs[0].outcome}` : ""}`
                      : "No runs yet"}
                  </small>
                </div>
                <div>
                  <button
                    onClick={() => start.mutate(journey.id)}
                    disabled={start.isPending}
                  >
                    Run journey
                  </button>
                  {journey.runs[0] && (
                    <button
                      className="text-button"
                      onClick={() => setRunId(journey.runs[0]!.id)}
                    >
                      View latest
                    </button>
                  )}
                </div>
              </div>
            ))}
            {start.isError && (
              <p role="alert" className="form-error">
                {start.error.message}
              </p>
            )}
          </div>
          {runId && (
            <div className="journey-result">
              <h3>Run details</h3>
              {run.isLoading && (
                <p role="status" className="state">
                  Loading run…
                </p>
              )}
              {run.isError && (
                <p role="alert" className="state error">
                  Could not load run details.
                </p>
              )}
              {run.data && (
                <>
                  <p role="status">
                    {run.data.status}
                    {run.data.outcome ? ` / ${run.data.outcome}` : ""}
                  </p>
                  {run.data.failureText && (
                    <p role="alert" className="form-error">
                      {run.data.failureText}
                    </p>
                  )}
                  <ol>
                    {run.data.stepResults.map((step) => (
                      <li key={step.id}>
                        <strong>{step.action}</strong>
                        <span
                          className={
                            step.outcome === "FAILED"
                              ? "form-error"
                              : "journey-success"
                          }
                        >
                          {step.outcome}
                        </span>
                        <small>
                          Expected: {step.expected ?? "—"}
                          <br />
                          Observed: {step.observed ?? "—"}
                        </small>
                        {step.failure && <small>{step.failure}</small>}
                        {step.auditFindings && (
                          <details className="journey-audit">
                            <summary>
                              {step.auditFindings.length} automated findings at
                              this step
                            </summary>
                            <ul>
                              {step.auditFindings.map((finding, index) => (
                                <li key={`${finding.ruleId}-${index}`}>
                                  <strong>{finding.help}</strong>
                                  <small>
                                    {finding.impact ?? "unknown"} ·{" "}
                                    {finding.ruleId} ·{" "}
                                    {finding.target.join(", ")}
                                  </small>
                                </li>
                              ))}
                            </ul>
                            <p>
                              Automated findings require human review; they do
                              not establish WCAG compliance.
                            </p>
                          </details>
                        )}
                        {step.screenshotKey && (
                          <a
                            className="journey-step-image"
                            href={`${API}/journey-runs/${runId}/steps/${step.sequence}/screenshot`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            <img
                              src={`${API}/journey-runs/${runId}/steps/${step.sequence}/screenshot`}
                              alt={`Page after step ${step.sequence + 1}: ${step.action}`}
                              loading="lazy"
                            />
                            <span>
                              Open step {step.sequence + 1} screenshot ↗
                            </span>
                          </a>
                        )}
                      </li>
                    ))}
                  </ol>
                  {run.data.screenshotKey && (
                    <a
                      href={`${API}/journey-runs/${runId}/screenshot`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open run screenshot ↗
                    </a>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Point = {
  scanId: string;
  completedAt: string;
  findingCount: number;
  uniqueFindingCount: number;
  newFindingCount: number;
  resolvedFindingCount: number;
  byImpact: Record<string, number>;
};
type Analytics = {
  completedScansConsidered: number;
  latest: Point | null;
  trend: Point[];
  limitations: string[];
};
type Project = { id: string; name: string };

function scanLabel(value: string) {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function AnalyticsPanel({ projects }: { projects: Project[] }) {
  const [selectedId, setSelectedId] = useState("");
  const projectId = projects.some((project) => project.id === selectedId)
    ? selectedId
    : (projects[0]?.id ?? "");
  const analytics = useQuery({
    queryKey: ["analytics", projectId],
    enabled: Boolean(projectId),
    queryFn: async (): Promise<Analytics> => {
      const response = await fetch(
        `http://127.0.0.1:4000/api/v1/projects/${projectId}/analytics`,
      );
      if (!response.ok) throw new Error("Could not load analytics");
      return response.json() as Promise<Analytics>;
    },
    refetchInterval: 5000,
  });
  const trend = Array.isArray(analytics.data?.trend)
    ? analytics.data.trend
    : [];
  const latest = analytics.data?.latest;
  const chartData = trend.map((point, index) => ({
    ...point,
    label: `${index + 1}: ${scanLabel(point.completedAt)}`,
  }));

  return (
    <section
      className="panel analytics-panel"
      id="analytics"
      aria-labelledby="analytics-title"
    >
      <div className="panel-heading">
        <div>
          <h2 id="analytics-title">Analytics</h2>
        </div>
      </div>
      {projects.length === 0 ? (
        <p>Add a project to see scan trends.</p>
      ) : (
        <>
          <label className="analytics-select">
            Project
            <select
              value={projectId}
              onChange={(event) => setSelectedId(event.target.value)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          {analytics.isLoading && <p role="status">Loading analytics…</p>}
          {analytics.isError && (
            <p role="alert">
              Could not load analytics.{" "}
              <button type="button" onClick={() => void analytics.refetch()}>
                Retry
              </button>
            </p>
          )}
          {analytics.isSuccess && trend.length === 0 && (
            <p>No completed scans yet. Run a scan to start the history.</p>
          )}
          {analytics.isSuccess && trend.length > 0 && (
            <>
              <div
                className="analytics-metrics"
                aria-label="Latest completed scan"
              >
                <div>
                  <strong>{latest?.findingCount ?? 0}</strong>
                  <span>Finding occurrences</span>
                </div>
                <div>
                  <strong>{latest?.uniqueFindingCount ?? 0}</strong>
                  <span>Unique findings</span>
                </div>
                <div>
                  <strong>{latest?.newFindingCount ?? 0}</strong>
                  <span>New fingerprints</span>
                </div>
                <div>
                  <strong>{latest?.resolvedFindingCount ?? 0}</strong>
                  <span>Resolved fingerprints</span>
                </div>
              </div>
              <h3>Finding occurrences by scan</h3>
              <div className="analytics-chart" aria-hidden="true">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={chartData}
                    margin={{ top: 10, right: 16, bottom: 10, left: 0 }}
                  >
                    <CartesianGrid stroke="#34454e" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="label"
                      stroke="#afc1c7"
                      tick={{ fontSize: 11 }}
                    />
                    <YAxis
                      allowDecimals={false}
                      stroke="#afc1c7"
                      tick={{ fontSize: 11 }}
                    />
                    <Tooltip
                      contentStyle={{
                        background: "#15232b",
                        color: "#e9edf1",
                        border: "1px solid #4a6b6e",
                      }}
                    />
                    <Line
                      type="linear"
                      dataKey="findingCount"
                      name="Finding occurrences"
                      stroke="#8dd6c7"
                      strokeWidth={3}
                      dot={{ r: 4 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="analytics-table-wrap">
                <table className="analytics-table">
                  <caption>Completed scan history, oldest to newest</caption>
                  <thead>
                    <tr>
                      <th scope="col">Completed</th>
                      <th scope="col">Occurrences</th>
                      <th scope="col">Unique</th>
                      <th scope="col">New</th>
                      <th scope="col">Resolved</th>
                      <th scope="col">Critical</th>
                      <th scope="col">Serious</th>
                      <th scope="col">Moderate</th>
                      <th scope="col">Minor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trend.map((point) => (
                      <tr key={point.scanId}>
                        <th scope="row">{scanLabel(point.completedAt)}</th>
                        <td>{point.findingCount}</td>
                        <td>{point.uniqueFindingCount}</td>
                        <td>{point.newFindingCount}</td>
                        <td>{point.resolvedFindingCount}</td>
                        <td>{point.byImpact.critical ?? 0}</td>
                        <td>{point.byImpact.serious ?? 0}</td>
                        <td>{point.byImpact.moderate ?? 0}</td>
                        <td>{point.byImpact.minor ?? 0}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="analytics-note">
                New and resolved compare unique fingerprints with the preceding
                completed scan. The first scan counts all its fingerprints as
                new. Automated findings do not certify WCAG compliance.
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}

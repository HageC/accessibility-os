"use client";

import {
  ReactFlow,
  Background,
  Controls,
  Position,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

export interface FocusObservation {
  id: string;
  sequence: number;
  direction: "FORWARD" | "BACKWARD";
  selector: string | null;
  tagName: string | null;
  role: string | null;
  name: string | null;
  elementId: string | null;
  isBody: boolean;
}

export function FocusExplorer({
  observations,
  artifacts,
}: {
  observations: FocusObservation[];
  artifacts: { id: string; kind: string }[];
}) {
  const nodes: Node[] = observations.map((item, index) => ({
    id: String(item.sequence),
    position: { x: (index % 4) * 230, y: Math.floor(index / 4) * 115 },
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: {
      label: `${index + 1}. ${item.name || item.elementId || item.tagName || "No active element"}`,
    },
    className:
      item.direction === "BACKWARD" ? "focus-node backward" : "focus-node",
  }));
  const edges: Edge[] = observations.slice(1).map((item, index) => ({
    id: `transition-${index}`,
    source: String(observations[index]!.sequence),
    target: String(item.sequence),
    animated: false,
    label: item.direction === "BACKWARD" ? "Shift+Tab" : "Tab",
    style: {
      stroke: item.direction === "BACKWARD" ? "#e2b87a" : "#8dd6c7",
      strokeWidth: 2,
    },
    labelStyle: { fill: "#d9e5e8" },
  }));
  const screenshots = new Map(
    artifacts
      .filter((artifact) => artifact.kind.startsWith("FOCUS_STEP_"))
      .map((artifact) => [artifact.kind, artifact.id]),
  );

  return (
    <>
      <div className="focus-graph" aria-label="Visual focus transition graph">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          fitView
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          colorMode="dark"
        >
          <Background color="#29444d" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <ol className="focus-list" aria-label="Recorded focus sequence">
        {observations.map((item) => {
          const screenshotId = screenshots.get(`FOCUS_STEP_${item.sequence}`);
          return (
            <li
              key={item.id}
              className={screenshotId ? "focus-row" : "focus-row no-image"}
            >
              <span className="focus-step">
                <span className="focus-step-number">{item.sequence + 1}</span>
                <span>
                  {item.direction === "BACKWARD" ? "Shift+Tab" : "Tab"}
                </span>
              </span>
              <span className="focus-target">
                <strong>
                  {item.name ||
                    item.elementId ||
                    item.tagName ||
                    "No active element"}
                </strong>
                <small>{item.role || item.tagName || "unknown role"}</small>
              </span>
              <code title={item.selector ?? undefined}>
                {item.selector ?? "No selector"}
              </code>
              {screenshotId && (
                <a
                  className="focus-thumbnail"
                  href={`http://127.0.0.1:4000/api/v1/artifacts/${screenshotId}`}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`Open focus step ${item.sequence + 1} screenshot`}
                >
                  <img
                    src={`http://127.0.0.1:4000/api/v1/artifacts/${screenshotId}`}
                    alt=""
                    loading="lazy"
                  />
                </a>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

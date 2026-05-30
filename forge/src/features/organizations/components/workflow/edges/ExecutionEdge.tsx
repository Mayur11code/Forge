"use client";

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";

export default function ExecutionEdge({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const isRunning = data?.status === "RUNNING";

  return (
    <>
      {/* glow */}
      {isRunning && (
        <BaseEdge
          path={path}
          style={{
            stroke: "#facc15",
            strokeWidth: 10,
            opacity: 0.15,
            filter: "blur(8px)",
          }}
        />
      )}

      {/* main line */}
      <BaseEdge
        path={path}
        markerEnd={markerEnd}
        style={{
          stroke:
            data?.status === "SUCCESS"
              ? "#10b981"
              : data?.status === "FAILED"
              ? "#ef4444"
              : data?.status === "RUNNING"
              ? "#facc15"
              : "#3f3f46",

          strokeWidth: 2.5,
          transition: "all 250ms ease",
          ...style,
        }}
      />

      {/* moving particle */}
      {isRunning && (
        <circle r="4" fill="#fde047">
          <animateMotion
            dur="1.2s"
            repeatCount="indefinite"
            path={path}
          />
        </circle>
      )}
    </>
  );
}
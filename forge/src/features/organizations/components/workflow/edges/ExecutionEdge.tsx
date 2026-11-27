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
            stroke: "#ffffff",
            strokeWidth: 8,
            opacity: 0.3,
            filter: "blur(6px)",
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
              ? "#e4e4e7"
              : data?.status === "FAILED"
              ? "#ef4444"
              : data?.status === "RUNNING"
              ? "#ffffff"
              : "#3f3f46",

          strokeWidth: 2.5,
          transition: "all 250ms ease",
          ...style,
        }}
      />

      {/* moving particle */}
      {isRunning && (
        <circle r="4" fill="#ffffff" filter="drop-shadow(0 0 6px rgba(255,255,255,0.9))">
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
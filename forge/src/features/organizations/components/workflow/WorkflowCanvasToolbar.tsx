"use client";

import React, { useState } from "react";
import { useReactFlow } from "@xyflow/react";
import {
  Zap,
  Settings2,
  Maximize2,
  Plus,
  Minus,
  Lock,
  Unlock,
  ChevronLeft,
  ChevronRight,
  Sparkles,
} from "lucide-react";

interface WorkflowCanvasToolbarProps {
  isLocked?: boolean;
  onToggleLock?: () => void;
}

export function WorkflowCanvasToolbar({
  isLocked = false,
  onToggleLock,
}: WorkflowCanvasToolbarProps) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const [isExpanded, setIsExpanded] = useState(true);

  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData("application/reactflow", nodeType);
    event.dataTransfer.effectAllowed = "move";
  };

  return (
    <div className="absolute top-4 left-4 z-20 flex items-start gap-2 select-none">
      {/* Floating Canvas Dock */}
      <div className="rounded-2xl border border-white/[0.1] bg-[#0c0c14]/90 backdrop-blur-2xl p-2 shadow-[0_16px_36px_rgba(0,0,0,0.7)] flex flex-col gap-2 transition-all duration-200">
        {/* Toggle Expand/Collapse */}
        <div className="flex items-center justify-between px-1">
          {isExpanded && (
            <span className="text-[9px] font-mono font-bold tracking-widest text-zinc-400 uppercase">
              [ PALETTE ]
            </span>
          )}
          <button
            type="button"
            onClick={() => setIsExpanded((v) => !v)}
            aria-label={isExpanded ? "Collapse Node Palette" : "Expand Node Palette"}
            className="h-6 w-6 rounded-lg border border-white/[0.08] bg-white/[0.03] flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors ml-auto"
            title={isExpanded ? "Collapse Palette" : "Expand Palette"}
          >
            {isExpanded ? <ChevronLeft size={13} /> : <ChevronRight size={13} />}
          </button>
        </div>

        {/* DRAGGABLE BLADES */}
        {isExpanded ? (
          <div className="flex flex-col gap-2 w-48">
            {/* Draggable Trigger Blade */}
            <div
              draggable
              onDragStart={(e) => onDragStart(e, "trigger")}
              className="group flex items-center gap-2.5 p-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.04] hover:bg-amber-500/[0.08] hover:border-amber-500/35 cursor-grab active:cursor-grabbing transition-all shadow-sm"
              title="Drag onto canvas to add an Event Trigger"
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/15 text-amber-300 border border-amber-500/25 shrink-0">
                <Zap size={14} fill="currentColor" />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-mono font-bold text-zinc-100 group-hover:text-amber-200 transition-colors">
                  Add Trigger
                </span>
                <span className="text-[10px] text-zinc-400 font-mono truncate">
                  CDC outbox event
                </span>
              </div>
            </div>

            {/* Draggable Action Blade */}
            <div
              draggable
              onDragStart={(e) => onDragStart(e, "action")}
              className="group flex items-center gap-2.5 p-2 rounded-xl border border-indigo-500/20 bg-indigo-500/[0.04] hover:bg-indigo-500/[0.08] hover:border-indigo-500/35 cursor-grab active:cursor-grabbing transition-all shadow-sm"
              title="Drag onto canvas to add a Compute Action"
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-500/15 text-indigo-300 border border-indigo-500/25 shrink-0">
                <Settings2 size={14} />
              </div>
              <div className="flex flex-col min-w-0">
                <span className="text-xs font-mono font-bold text-zinc-100 group-hover:text-indigo-200 transition-colors">
                  Add Action
                </span>
                <span className="text-[10px] text-zinc-400 font-mono truncate">
                  Compute blade
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 items-center">
            {/* Compact Draggable Trigger */}
            <div
              draggable
              onDragStart={(e) => onDragStart(e, "trigger")}
              className="group relative flex h-9 w-9 items-center justify-center rounded-xl border border-amber-500/25 bg-amber-500/[0.06] text-amber-300 hover:text-white hover:border-amber-500/40 hover:scale-105 cursor-grab active:cursor-grabbing transition-all shadow-sm"
              title="Add Trigger"
            >
              <Zap size={15} fill="currentColor" />
              <span className="sr-only">Add Trigger</span>
              <div
                role="tooltip"
                className="absolute left-full ml-2 px-2 py-0.5 rounded-lg bg-[#14141e] border border-amber-500/20 text-[10px] font-mono text-amber-200 shadow-xl pointer-events-none opacity-0 group-hover:opacity-100 transition-all z-30 whitespace-nowrap"
              >
                Drag Trigger
              </div>
            </div>

            {/* Compact Draggable Action */}
            <div
              draggable
              onDragStart={(e) => onDragStart(e, "action")}
              className="group relative flex h-9 w-9 items-center justify-center rounded-xl border border-indigo-500/25 bg-indigo-500/[0.06] text-indigo-300 hover:text-white hover:border-indigo-500/40 hover:scale-105 cursor-grab active:cursor-grabbing transition-all shadow-sm"
              title="Add Action"
            >
              <Settings2 size={15} />
              <span className="sr-only">Add Action</span>
              <div
                role="tooltip"
                className="absolute left-full ml-2 px-2 py-0.5 rounded-lg bg-[#14141e] border border-indigo-500/20 text-[10px] font-mono text-indigo-200 shadow-xl pointer-events-none opacity-0 group-hover:opacity-100 transition-all z-30 whitespace-nowrap"
              >
                Drag Action
              </div>
            </div>
          </div>
        )}

        {/* Separator */}
        <div className="h-[1px] w-full bg-white/[0.08]" />

        {/* CANVAS CONTROLS */}
        <div className={isExpanded ? "flex items-center justify-between gap-1 pt-0.5" : "flex flex-col gap-1 items-center"}>
          {/* Fit View */}
          <button
            type="button"
            onClick={() => fitView({ duration: 300, padding: 0.2 })}
            className="h-7 w-7 rounded-lg border border-white/[0.08] bg-white/[0.03] flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors"
            title="Fit View"
            aria-label="Fit View"
          >
            <Maximize2 size={13} />
          </button>

          {/* Zoom In */}
          <button
            type="button"
            onClick={() => zoomIn({ duration: 200 })}
            className="h-7 w-7 rounded-lg border border-white/[0.08] bg-white/[0.03] flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors"
            title="Zoom In"
            aria-label="Zoom In"
          >
            <Plus size={14} />
          </button>

          {/* Zoom Out */}
          <button
            type="button"
            onClick={() => zoomOut({ duration: 200 })}
            className="h-7 w-7 rounded-lg border border-white/[0.08] bg-white/[0.03] flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors"
            title="Zoom Out"
            aria-label="Zoom Out"
          >
            <Minus size={14} />
          </button>

          {/* Lock Pan/Zoom */}
          {onToggleLock && (
            <button
              type="button"
              onClick={onToggleLock}
              className={`h-7 w-7 rounded-lg border flex items-center justify-center transition-colors ${
                isLocked
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                  : "border-white/[0.08] bg-white/[0.03] text-zinc-400 hover:text-white hover:bg-white/[0.08]"
              }`}
              title={isLocked ? "Unlock Canvas Pan" : "Lock Canvas Pan"}
              aria-label={isLocked ? "Unlock Canvas Pan" : "Lock Canvas Pan"}
            >
              {isLocked ? <Lock size={12} /> : <Unlock size={12} />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

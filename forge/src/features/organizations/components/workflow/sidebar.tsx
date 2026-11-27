"use client";

import { Zap, Settings2, ChevronLeft, ChevronRight } from "lucide-react";

interface SidebarProps {
  isCollapsed?: boolean;
  onToggleCollapse?: () => void;
}

export default function Sidebar({
  isCollapsed = false,
  onToggleCollapse,
}: SidebarProps) {
  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  if (isCollapsed) {
    return (
      <aside className="w-14 border-r border-white/[0.08] bg-[#07070a]/95 backdrop-blur-xl p-2 flex flex-col items-center gap-3 shrink-0 shadow-2xl transition-all duration-300">
        <button
          type="button"
          onClick={onToggleCollapse}
          className="h-8 w-8 rounded-lg border border-white/[0.1] bg-white/[0.04] flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors"
          title="Expand Node Palette"
          aria-label="Expand Node Palette"
        >
          <ChevronRight size={14} />
        </button>

        {/* Compact Drag Trigger */}
        <div
          className="group relative flex h-10 w-10 cursor-grab items-center justify-center rounded-xl border border-white/[0.1] bg-white/[0.04] text-zinc-300 hover:text-white hover:border-white/30 hover:scale-105 active:cursor-grabbing transition-all shadow-sm"
          onDragStart={(event) => onDragStart(event, 'trigger')}
          draggable
          title="Add Trigger (Drag onto canvas)"
        >
          <Zap size={16} fill="currentColor" />
        </div>

        {/* Compact Drag Action */}
        <div
          className="group relative flex h-10 w-10 cursor-grab items-center justify-center rounded-xl border border-white/[0.1] bg-white/[0.04] text-zinc-300 hover:text-white hover:border-white/30 hover:scale-105 active:cursor-grabbing transition-all shadow-sm"
          onDragStart={(event) => onDragStart(event, 'action')}
          draggable
          title="Add Action (Drag onto canvas)"
        >
          <Settings2 size={16} />
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-64 border-r border-white/[0.08] bg-[#07070a]/95 backdrop-blur-xl p-4 flex flex-col gap-4 shrink-0 shadow-2xl transition-all duration-300">
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-[10px] font-mono tracking-widest text-zinc-400 font-bold uppercase">
            [ 01 ] NODE PALETTE
          </span>
          {onToggleCollapse && (
            <button
              type="button"
              onClick={onToggleCollapse}
              className="h-6 w-6 rounded border border-white/[0.1] bg-white/[0.04] flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors"
              title="Collapse Node Palette"
              aria-label="Collapse Node Palette"
            >
              <ChevronLeft size={13} />
            </button>
          )}
        </div>
        <p className="text-[11px] text-zinc-500 font-mono">
          Drag onto canvas to construct DAG flow
        </p>
      </div>

      <div className="space-y-3">
        {/* Sleek Dark Trigger Blade */}
        <div
          className="group relative flex cursor-grab flex-col gap-2 rounded-xl border border-white/[0.1] bg-zinc-950/60 p-3.5 transition-all duration-300 hover:border-white/30 hover:bg-white/[0.04] active:cursor-grabbing shadow-sm"
          onDragStart={(event) => onDragStart(event, 'trigger')}
          draggable
        >
          <div className="flex items-center justify-between">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.12] bg-white/[0.06] text-zinc-200 group-hover:scale-105 transition-transform">
              <Zap size={16} fill="currentColor" />
            </div>
            <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-zinc-300 bg-white/[0.06] border border-white/[0.12] px-1.5 py-0.5 rounded">
              [ TRG 01 ]
            </span>
          </div>
          <div>
            <span className="text-sm font-semibold text-zinc-200 group-hover:text-white transition-colors block">
              Add Trigger
            </span>
            <span className="text-[11px] text-zinc-500 group-hover:text-zinc-400 transition-colors block">
              Listen to CDC domain outbox stream
            </span>
          </div>
        </div>

        {/* Sleek Dark Action Blade */}
        <div
          className="group relative flex cursor-grab flex-col gap-2 rounded-xl border border-white/[0.1] bg-zinc-950/60 p-3.5 transition-all duration-300 hover:border-white/30 hover:bg-white/[0.04] active:cursor-grabbing shadow-sm"
          onDragStart={(event) => onDragStart(event, 'action')}
          draggable
        >
          <div className="flex items-center justify-between">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/[0.12] bg-white/[0.06] text-zinc-200 group-hover:scale-105 transition-transform">
              <Settings2 size={16} />
            </div>
            <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-zinc-300 bg-white/[0.06] border border-white/[0.12] px-1.5 py-0.5 rounded">
              [ ACT 02 ]
            </span>
          </div>
          <div>
            <span className="text-sm font-semibold text-zinc-200 group-hover:text-white transition-colors block">
              Add Action
            </span>
            <span className="text-[11px] text-zinc-500 group-hover:text-zinc-400 transition-colors block">
              Atomic transactional compute blade
            </span>
          </div>
        </div>
      </div>

      <div className="mt-auto rounded-xl border border-white/[0.06] bg-black/40 p-3 font-mono text-[10px] text-zinc-500 space-y-1">
        <div className="flex items-center gap-1.5 text-zinc-400 font-medium">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.7)] animate-pulse" />
          <span>AEROSPACE DAG ENGINE</span>
        </div>
        <p className="text-[9px] text-zinc-600 leading-relaxed">
          Transactional idempotency & topological order guaranteed by runtime kernel.
        </p>
      </div>
    </aside>
  );
}

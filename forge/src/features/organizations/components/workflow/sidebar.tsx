"use client";

import { Zap, Settings2 } from "lucide-react";

export default function Sidebar() {
  const onDragStart = (event: React.DragEvent, nodeType: string) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <aside className="w-64 border-r border-zinc-800 bg-[#0a0a0a] p-4 flex flex-col gap-4">
      <h2 className="text-xs font-bold text-zinc-500 uppercase tracking-wider mb-2">
        Nodes
      </h2>

      {/* Sleek Dark Trigger Tool */}
      <div
        className="flex cursor-grab items-center gap-3 rounded-lg border border-zinc-800 bg-[#121212] p-3 transition-colors hover:border-emerald-500/50 hover:bg-emerald-500/5 active:cursor-grabbing"
        onDragStart={(event) => onDragStart(event, 'trigger')}
        draggable
      >
        <Zap size={18} className="text-emerald-500" />
        <span className="text-sm font-medium text-zinc-300">Add Trigger</span>
      </div>

      {/* Sleek Dark Action Tool */}
      <div
        className="flex cursor-grab items-center gap-3 rounded-lg border border-zinc-800 bg-[#121212] p-3 transition-colors hover:border-blue-500/50 hover:bg-blue-500/5 active:cursor-grabbing"
        onDragStart={(event) => onDragStart(event, 'action')}
        draggable
      >
        <Settings2 size={18} className="text-blue-500" />
        <span className="text-sm font-medium text-zinc-300">Add Action</span>
      </div>
    </aside>
  );
}
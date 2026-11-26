"use client";

import { useState, useEffect, useCallback } from "react";
import { X, ShieldAlert, CheckCircle2 } from "lucide-react";

interface SystemEvent {
  id: number;
  left: number;
  top: number;
  type: string;
  speed: number;
  accent: string;
}

const EVENT_TYPES = [
  { name: "TASK_CREATED", accent: "#ffffff" },
  { name: "FILE_UPLOADED", accent: "#e4e4e7" },
  { name: "WORKFLOW_EXECUTED", accent: "#d4d4d8" },
  { name: "ROLE_CHANGED", accent: "#f4f4f5" },
  { name: "VECTOR_EMBEDDED", accent: "#a1a1aa" },
  { name: "QUOTA_UPDATED", accent: "#e4e4ed" },
  { name: "ROW_MUTEX_ACQUIRED", accent: "#ffffff" },
  { name: "CDC_OUTBOX_COMMITTED", accent: "#f5f5f5" },
];

interface SystemEventsGameProps {
  isOpen: boolean;
  onClose: () => void;
  onPlayClickSound?: () => void;
}

export function SystemEventsGame({
  isOpen,
  onClose,
  onPlayClickSound,
}: SystemEventsGameProps) {
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [processedCount, setProcessedCount] = useState(0);
  const [missedCount, setMissedCount] = useState(0);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Spawner and Physics Game Loops
  useEffect(() => {
    if (!isOpen) {
      setEvents([]);
      return;
    }

    // Spawn a new event every 650ms
    const spawner = setInterval(() => {
      const typeCfg = EVENT_TYPES[Math.floor(Math.random() * EVENT_TYPES.length)];
      setEvents((prev) => [
        ...prev,
        {
          id: Date.now() + Math.random(),
          left: Math.random() * 74 + 12, // Keep away from extreme screen edges
          top: -8,
          type: typeCfg.name,
          speed: 0.9 + Math.random() * 0.7,
          accent: typeCfg.accent,
        },
      ]);
    }, 650);

    // Physics step every 40ms (~25fps movement)
    const physics = setInterval(() => {
      setEvents((prev) => {
        const next: SystemEvent[] = [];
        let dropped = 0;
        for (const ev of prev) {
          const nextTop = ev.top + ev.speed;
          if (nextTop > 105) {
            dropped++;
          } else {
            next.push({ ...ev, top: nextTop });
          }
        }
        if (dropped > 0) {
          setMissedCount((m) => m + dropped);
        }
        return next;
      });
    }, 40);

    return () => {
      clearInterval(spawner);
      clearInterval(physics);
    };
  }, [isOpen]);

  const handleProcessEvent = useCallback(
    (id: number, e: React.PointerEvent<HTMLButtonElement>) => {
      e.stopPropagation();
      e.preventDefault();
      onPlayClickSound?.();
      setEvents((prev) => prev.filter((ev) => ev.id !== id));
      setProcessedCount((c) => c + 1);
    },
    [onPlayClickSound]
  );

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] bg-[#060608]/92 backdrop-blur-xl flex flex-col justify-between p-6 sm:p-10 select-none overflow-hidden">
      {/* Background Architectural Grid Pattern */}
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,#ffffff05_1px,transparent_1px),linear-gradient(to_bottom,#ffffff05_1px,transparent_1px)] bg-[size:4rem_4rem]" />

      {/* Top HUD Console */}
      <div className="relative z-10 flex flex-wrap items-center justify-between gap-4 border-b border-white/[0.12] pb-5">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-sm bg-white" />
          <div className="font-mono text-xs text-zinc-300 tracking-wider">
            <span className="text-white font-bold">[ CDC EVENT STREAM SIMULATION ]</span>
            <span className="hidden sm:inline text-zinc-500 ml-2">· CLICK EVENTS TO STABILIZE STREAM</span>
          </div>
        </div>

        <div className="flex items-center gap-6 font-mono text-xs">
          <div className="flex items-center gap-2">
            <span className="text-zinc-500">STABILIZED:</span>
            <span className="text-white font-bold text-base px-2 py-0.5 border border-white/[0.2] bg-white/[0.04]">
              {processedCount}
            </span>
          </div>

          <div className="hidden sm:flex items-center gap-2">
            <span className="text-zinc-500">DROPPED:</span>
            <span className="text-zinc-400 font-bold">{missedCount}</span>
          </div>

          <button
            onClick={onClose}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-white/[0.2] hover:border-white text-zinc-300 hover:text-white bg-zinc-950 font-mono text-xs transition-all tracking-wider"
          >
            <X className="w-3.5 h-3.5" />
            <span>ABORT [ESC]</span>
          </button>
        </div>
      </div>

      {/* Falling System Events Stream Field */}
      <div className="relative flex-1 w-full h-full overflow-hidden">
        {events.map((ev) => (
          <button
            key={ev.id}
            onPointerDown={(e) => handleProcessEvent(ev.id, e)}
            style={{
              left: `${ev.left}%`,
              top: `${ev.top}%`,
            }}
            className="absolute -translate-x-1/2 cursor-pointer border border-white/[0.24] hover:border-white bg-[#0e0e15]/95 hover:bg-white/[0.12] px-3.5 py-2 font-mono text-xs text-white tracking-wider shadow-2xl backdrop-blur-md transition-transform hover:scale-110 active:scale-95 group flex items-center gap-2"
          >
            <span className="w-1.5 h-1.5 bg-zinc-400 group-hover:bg-white rounded-none" />
            <span>{ev.type}</span>
          </button>
        ))}

        {events.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-center font-mono text-xs text-zinc-500 pointer-events-none">
            <ShieldAlert className="w-8 h-8 text-zinc-600 mb-2" />
            <div>INITIALIZING EVENT QUEUE...</div>
            <div className="text-[10px] text-zinc-600 mt-1">CLICK INCOMING DOMAIN EVENTS TO COMMIT</div>
          </div>
        )}
      </div>

      {/* Bottom Technical Status Bar */}
      <div className="relative z-10 flex flex-wrap items-center justify-between text-[11px] font-mono text-zinc-500 border-t border-white/[0.08] pt-4">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-3.5 h-3.5 text-zinc-400" />
          <span>TRANSACTIONAL INTEGRITY: ENFORCED</span>
        </div>
        <div className="hidden sm:block">
          <span>LATENCY: 0.18ms · FIFO QUEUE LEASE: ACTIVE</span>
        </div>
        <div>
          <span>FORGE ENGINE v0.1.0-ALPHA</span>
        </div>
      </div>
    </div>
  );
}

export default SystemEventsGame;

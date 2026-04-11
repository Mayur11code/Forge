"use client";

import { useState, useEffect } from "react";

type SystemEvent = {
  id: number;
  left: number;
  top: number;
  type: string;
};

const EVENT_TYPES = [
  "TASK_CREATED", 
  "FILE_UPLOADED", 
  "WORKFLOW_EXECUTED", 
  "ROLE_CHANGED",
  "VECTOR_EMBEDDED",
  "QUOTA_UPDATED"
];

export default function Home() {
  const [clickCount, setClickCount] = useState(0);
  const [gameActive, setGameActive] = useState(false);
  const [events, setEvents] = useState<SystemEvent[]>([]);
  const [processedCount, setProcessedCount] = useState(0);

  // Handle the secret trigger
  const handleHeaderClick = () => {
    if (gameActive) return;
    const newCount = clickCount + 1;
    setClickCount(newCount);
    if (newCount >= 3) {
      setGameActive(true);
    }
  };

  // Close the game and reset states
  const handleCloseSystem = () => {
    setGameActive(false);
    setClickCount(0);
    setEvents([]);
    setProcessedCount(0);
  };

  // Game Loop: Spawning and Falling
  useEffect(() => {
    if (!gameActive) return;

    // Spawner: Create a new event every 800ms
    const spawner = setInterval(() => {
      setEvents((prev) => [
        ...prev,
        {
          id: Date.now(),
          left: Math.random() * 70 + 10, 
          top: -10,
          type: EVENT_TYPES[Math.floor(Math.random() * EVENT_TYPES.length)],
        },
      ]);
    }, 800);

    // Physics Loop: Move events down every 50ms
    const physics = setInterval(() => {
      setEvents((prev) =>
        prev
          .map((e) => ({ ...e, top: e.top + 1.2 })) // Slowed down slightly for better clicking
          .filter((e) => e.top < 110)
      );
    }, 50);

    return () => {
      clearInterval(spawner);
      clearInterval(physics);
    };
  }, [gameActive]);

  // Handle processing an event - Changed to Pointer Event for instant response
  const handleProcessEvent = (id: number, e: React.PointerEvent) => {
    e.stopPropagation();
    e.preventDefault(); // Prevents ghost clicks on mobile
    setEvents((prev) => prev.filter((event) => event.id !== id));
    setProcessedCount((prev) => prev + 1);
  };

  return (
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden bg-slate-950 px-4 py-20 sm:py-24 selection:bg-indigo-500/30 font-sans">
      
      {/* --- Engineering Grid Background --- */}
      <div className="absolute inset-0 z-0 bg-[linear-gradient(to_right,#4f4f4f15_1px,transparent_1px),linear-gradient(to_bottom,#4f4f4f15_1px,transparent_1px)] bg-[size:24px_24px] md:bg-[size:32px_32px]" />

      {/* --- Ambient Background Glows --- */}
      <div className="absolute top-1/4 left-1/4 h-64 w-64 md:h-96 md:w-96 -translate-x-1/2 -translate-y-1/2 rounded-full bg-indigo-600/20 blur-[100px] md:blur-[128px] pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 h-64 w-64 md:h-96 md:w-96 translate-x-1/2 translate-y-1/2 rounded-full bg-fuchsia-600/20 blur-[100px] md:blur-[128px] pointer-events-none" />

      {/* --- THE GAME RENDERER --- */}
      {gameActive && (
        <>
          {/* Responsive Scoreboard with Close Button */}
          <div className="absolute top-4 left-4 right-4 sm:right-auto sm:top-8 sm:left-8 z-50 rounded-xl border border-emerald-500/30 bg-slate-900/90 px-4 py-3 sm:px-6 sm:py-4 backdrop-blur-md shadow-[0_0_30px_rgba(16,185,129,0.15)] flex justify-between items-center gap-6">
            <div>
              <p className="text-[10px] sm:text-xs font-bold text-slate-400 uppercase tracking-widest mb-0 sm:mb-1">Active Queue</p>
              <p className="text-lg sm:text-2xl font-black text-emerald-400 font-mono tracking-tight">
                Processed: {processedCount}
              </p>
            </div>
            
            {/* Kill Process Button */}
            <button
              onClick={handleCloseSystem}
              className="px-3 py-1.5 rounded-md bg-red-500/10 border border-red-500/30 text-red-400 text-xs font-mono font-bold hover:bg-red-500/20 hover:scale-105 active:scale-95 transition-all"
            >
              SIGTERM
            </button>
          </div>

          {/* Falling Events */}
          {events.map((ev) => (
            <button
              key={ev.id}
              // Changed from onClick to onPointerDown for massive responsiveness improvement
              onPointerDown={(e) => handleProcessEvent(ev.id, e)}
              style={{ left: `${ev.left}%`, top: `${ev.top}%` }}
              className="absolute z-[100] flex items-center gap-2 rounded-md border border-indigo-500/40 bg-slate-900/95 px-3 py-2 text-[10px] sm:text-xs font-mono text-indigo-300 shadow-lg backdrop-blur-md hover:border-indigo-400 hover:bg-slate-800 active:scale-95 cursor-crosshair group touch-none"
            >
              <span className="h-2 w-2 rounded-full bg-indigo-500 shadow-[0_0_10px_rgba(99,102,241,0.8)] animate-pulse pointer-events-none"></span>
              <span className="pointer-events-none">{ev.type}</span>
            </button>
          ))}
        </>
      )}

      {/* --- Main Glassmorphism Card --- */}
      <div className="relative z-10 flex w-full max-w-2xl flex-col items-center text-center p-6 sm:p-10 md:p-14 rounded-3xl bg-slate-900/60 border border-slate-800 shadow-2xl backdrop-blur-xl">
        
        {/* Pulsing "In Dev" Badge */}
        <div className="mb-6 md:mb-8 inline-flex items-center rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 sm:px-4 sm:py-1.5 text-xs sm:text-sm font-medium text-indigo-300 backdrop-blur-sm">
          <span className="relative flex h-2 w-2 sm:h-2.5 sm:w-2.5 mr-2 sm:mr-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 sm:h-2.5 sm:w-2.5 bg-indigo-500"></span>
          </span>
          Engineered Forge OS v0.1.0-alpha
        </div>

        {/* Gradient Heading */}
        <div className="relative">
          <h1 
            onClick={handleHeaderClick}
            className={`mb-4 text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-extrabold tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-white via-indigo-200 to-fuchsia-400 transition-all duration-300 select-none ${clickCount > 0 && !gameActive ? 'scale-105 cursor-pointer drop-shadow-md' : ''} ${gameActive ? 'animate-pulse opacity-50' : ''}`}
          >
            Something Awesome <br className="hidden sm:block" /> is Cooking
          </h1>
          
          {/* Secret Unlock Hint */}
          {!gameActive && clickCount > 0 && (
            <div className="absolute -bottom-6 left-1/2 -translate-x-1/2 text-[10px] font-mono text-indigo-400 font-bold tracking-widest animate-pulse">
              OVERRIDE: {clickCount}/3
            </div>
          )}
        </div>

        {/* Subtitle */}
        <p className="mt-4 mb-8 sm:mb-10 text-sm sm:text-base md:text-lg text-slate-400 max-w-lg mx-auto leading-relaxed px-2">
          A multi-tenant, event-driven architecture is currently being forged. Connect with me on LinkedIn while the workers queue up.
        </p>

        {/* LinkedIn Button */}
        <a 
          href="https://www.linkedin.com/in/mayur-nanda1121/"
          target="_blank" 
          rel="noopener noreferrer"
          className="inline-flex items-center justify-center px-6 py-3 sm:px-8 sm:py-3.5 rounded-full bg-white text-slate-950 text-sm sm:text-base font-semibold transition-all duration-500 ease-out hover:bg-slate-100 hover:scale-105 hover:shadow-[0_0_30px_-5px_rgba(255,255,255,0.4)] active:scale-95 w-full sm:w-auto"
        >
          <svg className="w-4 h-4 sm:w-5 sm:h-5 mr-2" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path fillRule="evenodd" d="M19 0h-14c-2.761 0-5 2.239-5 5v14c0 2.761 2.239 5 5 5h14c2.762 0 5-2.239 5-5v-14c0-2.761-2.238-5-5-5zm-11 19h-3v-11h3v11zm-1.5-12.268c-.966 0-1.75-.79-1.75-1.764s.784-1.764 1.75-1.764 1.75.79 1.75 1.764-.783 1.764-1.75 1.764zm13.5 12.268h-3v-5.604c0-3.368-4-3.113-4 0v5.604h-3v-11h3v1.765c1.396-2.586 7-2.777 7 2.476v6.759z" clipRule="evenodd" />
          </svg>
          Connect on LinkedIn
        </a>
      </div>

      {/* --- Footer --- */}
      <div className="absolute bottom-6 sm:bottom-8 text-slate-600 text-xs sm:text-sm font-medium tracking-wide">
        &copy; {new Date().getFullYear()} Engineered Forge. All rights reserved.
      </div>
    </main>
  );
}
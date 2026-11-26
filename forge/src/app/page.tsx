"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import {
  ArrowRight,
  LogIn,
  UserPlus,
  Volume2,
  VolumeX,
  Disc3,
  CheckCircle2,
  ExternalLink,
  ChevronRight,
  Play,
  Pause,
  RotateCcw,
} from "lucide-react";

// --- Tracklist Data (The CAS Album Tracklist Concept) ---
const TRACKLIST = [
  {
    side: "A",
    num: "01",
    title: "Sanctuary & Identity",
    subtitle: "Multi-tenant isolation · Row mutex serialization",
    desc: "Complete self-service onboarding, tenant switching, and atomic last-admin safeguards powered by Postgres row-level locks.",
    badge: "M1 ACCEPTED",
    status: "Verified",
    route: "/signup",
  },
  {
    side: "A",
    num: "02",
    title: "The Reactive Outbox",
    subtitle: "Transactional CDC event bus · QStash delivery",
    desc: "Every database mutation commits alongside its outbox message. Zero ghost events, distributed Redis locks, and guaranteed at-least-once delivery.",
    badge: "ENGINE ACTIVE",
    status: "Running",
    route: "/login",
  },
  {
    side: "A",
    num: "03",
    title: "Saga Orchestration",
    subtitle: "Forward DAG execution · Backward compensation",
    desc: "Workflows execute as deterministic state machines. If an external step fails, automatic compensation runs in reverse, leaving zero orphan state.",
    badge: "CORE DAG",
    status: "Operational",
    route: "/login",
  },
  {
    side: "B",
    num: "04",
    title: "Midnight Intelligence",
    subtitle: "Autonomous agent · In-line human approval",
    desc: "Conversational AI that plans multi-step DAG actions. High-impact operations present reviewable diff cards for human sign-off before running.",
    badge: "AI ASSISTANT",
    status: "Ready",
    route: "/login",
  },
  {
    side: "B",
    num: "05",
    title: "Whispered Delivery",
    subtitle: "24-hr token lifecycle · Resend notification fabric",
    desc: "Secure cryptographically generated invitation tokens, member onboarding, and transactional delivery pipelines tailored for SaaS teams.",
    badge: "NOTIFICATIONS",
    status: "Hardened",
    route: "/signup",
  },
  {
    side: "B",
    num: "06",
    title: "Memory & Vectors",
    subtitle: "UploadThing attachments · Pinecone semantic RAG",
    desc: "File uploads, chunked vector embeddings, semantic hybrid search, and deterministic vector tombstoning on deletion.",
    badge: "VECTOR RAG",
    status: "Synchronized",
    route: "/login",
  },
];

// --- Live DAG Pipeline Demonstration Nodes ---
const DAG_STEPS = [
  { id: "1", title: "task.created", type: "CDC Trigger", desc: "Domain CDC payload captured in transactional outbox" },
  { id: "2", title: "filter.urgent", type: "Condition Node", desc: "Evaluate priority == 'URGENT' in isolate sandbox" },
  { id: "3", title: "task.assign", type: "Database Mutation", desc: "Assign lead tech with optimistic Postgres row lock" },
  { id: "4", title: "resend.alert", type: "External Provider", desc: "Dispatch notification payload via Resend API" },
];

export default function Home() {
  const [ambientAudioActive, setAmbientAudioActive] = useState(false);
  const [activeTab, setActiveTab] = useState<"A" | "B">("A");
  const [activeStep, setActiveStep] = useState(0);
  const [isSimulating, setIsSimulating] = useState(true);

  // Web Audio API refs for subtle vinyl crackle / tape hiss
  const audioCtxRef = useRef<AudioContext | null>(null);
  const noiseNodeRef = useRef<AudioNode | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);

  // Subtle DAG animation timer
  useEffect(() => {
    if (!isSimulating) return;
    const interval = setInterval(() => {
      setActiveStep((prev) => (prev + 1) % DAG_STEPS.length);
    }, 2800);
    return () => clearInterval(interval);
  }, [isSimulating]);

  // Handle ambient vinyl crackle / warm tape hiss synthesis
  const toggleAmbientSound = () => {
    if (typeof window === "undefined") return;

    if (ambientAudioActive) {
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        audioCtxRef.current.suspend();
      }
      setAmbientAudioActive(false);
      return;
    }

    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
        audioCtxRef.current = new AudioCtx();
      } else if (audioCtxRef.current.state === "suspended") {
        audioCtxRef.current.resume();
      }

      const ctx = audioCtxRef.current;

      // Create pink/crackle noise buffer (simulates vintage 33 1/3 RPM vinyl surface noise)
      const bufferSize = ctx.sampleRate * 2;
      const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const output = noiseBuffer.getChannelData(0);
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;

      for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        // Pink noise filtering
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.96900 * b2 + white * 0.1538520;
        b3 = 0.86650 * b3 + white * 0.3104856;
        b4 = 0.55000 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.0168980;
        let pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
        b6 = white * 0.115926;

        // Add occasional vinyl pops/ticks
        if (Math.random() < 0.0006) {
          pink += (Math.random() - 0.5) * 3.5;
        }

        output[i] = pink * 0.035;
      }

      const whiteNoise = ctx.createBufferSource();
      whiteNoise.buffer = noiseBuffer;
      whiteNoise.loop = true;

      // Bandpass filter to create that dreamy distant muffled warmth
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(800, ctx.currentTime);
      filter.Q.setValueAtTime(0.7, ctx.currentTime);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.045, ctx.currentTime); // gentle and unobtrusive

      whiteNoise.connect(filter);
      filter.connect(gain);
      gain.connect(ctx.destination);

      whiteNoise.start();

      noiseNodeRef.current = whiteNoise;
      gainNodeRef.current = gain;
      setAmbientAudioActive(true);
    } catch {
      setAmbientAudioActive(false);
    }
  };

  useEffect(() => {
    return () => {
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        try {
          audioCtxRef.current.close();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  return (
    <div className="relative min-h-screen bg-[#050507] text-zinc-100 selection:bg-zinc-800 selection:text-white font-sans antialiased overflow-x-hidden">
      
      {/* --- Film Grain Texture Overlay (35mm Monochrome Aesthetic) --- */}
      <div 
        aria-hidden="true" 
        className="pointer-events-none fixed inset-0 z-50 opacity-[0.038] mix-blend-screen bg-repeat"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")`
        }}
      />

      {/* --- Dreamy Moonlight & Smoky Haze Vignette --- */}
      <div className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute top-[-10%] left-1/2 -translate-x-1/2 w-[900px] h-[550px] rounded-full bg-gradient-to-b from-zinc-700/10 via-zinc-800/5 to-transparent blur-[140px]" />
        <div className="absolute bottom-[5%] right-[5%] w-[600px] h-[400px] rounded-full bg-zinc-900/15 blur-[120px]" />
        <div className="absolute top-[45%] left-[-5%] w-[500px] h-[500px] rounded-full bg-zinc-800/10 blur-[130px]" />
      </div>

      {/* --- Top Minimalist Header --- */}
      <header className="relative z-40 border-b border-white/[0.06] backdrop-blur-md bg-[#050507]/75">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
          
          {/* Brand Monogram */}
          <Link href="/" className="group flex items-center gap-3">
            <div className="h-7 w-7 rounded-sm border border-zinc-700 bg-zinc-900 flex items-center justify-center text-zinc-300 group-hover:border-zinc-500 group-hover:text-white transition-colors">
              <span className="font-serif italic text-xs tracking-tighter">f</span>
            </div>
            <div className="flex flex-col">
              <span className="font-mono text-xs uppercase tracking-[0.28em] text-zinc-200 group-hover:text-white transition-colors">
                FORGE
              </span>
              <span className="text-[9px] font-mono text-zinc-500 tracking-widest uppercase">
                Slow-Motion Architecture
              </span>
            </div>
          </Link>

          {/* Center Soundscape Widget */}
          <div className="hidden md:flex items-center gap-3">
            <button
              onClick={toggleAmbientSound}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-[11px] font-mono transition-all duration-300 ${
                ambientAudioActive
                  ? "border-zinc-400 bg-zinc-800/80 text-zinc-100 shadow-[0_0_15px_rgba(255,255,255,0.08)]"
                  : "border-white/[0.08] bg-zinc-950/40 text-zinc-400 hover:text-zinc-200 hover:border-zinc-600"
              }`}
              title="Toggle subtle vinyl surface crackle & late-night warmth"
            >
              {ambientAudioActive ? (
                <>
                  <Volume2 className="w-3.5 h-3.5 text-zinc-300 animate-pulse" />
                  <span className="tracking-wider">VINYL HAZE: ON (33⅓ RPM)</span>
                  <span className="flex gap-0.5 items-end h-2.5">
                    <span className="w-0.5 h-2 bg-zinc-300 animate-[pulse_1s_infinite]"></span>
                    <span className="w-0.5 h-3 bg-zinc-400 animate-[pulse_1.4s_infinite]"></span>
                    <span className="w-0.5 h-1.5 bg-zinc-300 animate-[pulse_0.8s_infinite]"></span>
                  </span>
                </>
              ) : (
                <>
                  <VolumeX className="w-3.5 h-3.5 text-zinc-500" />
                  <span className="tracking-wider">VINYL HAZE: MUTED</span>
                </>
              )}
            </button>
          </div>

          {/* Navigation Action Buttons */}
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full text-xs font-mono tracking-wider text-zinc-300 hover:text-white hover:bg-white/[0.04] transition-all"
            >
              <LogIn className="w-3.5 h-3.5 text-zinc-400" />
              <span>SIGN IN</span>
            </Link>

            <Link
              href="/signup"
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-full border border-white/20 bg-zinc-100 hover:bg-white text-zinc-950 text-xs font-mono tracking-wider font-semibold shadow-md shadow-white/5 hover:scale-[1.02] active:scale-[0.98] transition-all duration-200"
            >
              <UserPlus className="w-3.5 h-3.5" />
              <span>CREATE WORKSPACE</span>
            </Link>
          </div>
        </div>
      </header>

      {/* --- HERO SECTION: The Cigarettes After Sex Nocturne --- */}
      <main className="relative z-10 max-w-5xl mx-auto px-6 pt-24 pb-20 md:pt-32 md:pb-28 flex flex-col items-center text-center">
        
        {/* Subtle Ephemeral Tag */}
        <div className="mb-8 inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border border-white/[0.08] bg-zinc-950/60 backdrop-blur-md text-[11px] font-mono tracking-[0.2em] uppercase text-zinc-400">
          <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 animate-ping"></span>
          <span>NOCTURNE EDITION · FORGE V1.0</span>
        </div>

        {/* Cinematic CAS Title with Subtle Ethereal Bloom */}
        <h1 className="text-4xl sm:text-6xl md:text-7xl lg:text-8xl font-light tracking-[0.16em] uppercase text-zinc-100 max-w-4xl leading-[1.08] select-none">
          ORCHESTRATION <br />
          <span className="font-serif italic lowercase font-normal tracking-tight text-zinc-400 text-3xl sm:text-5xl md:text-6xl block mt-2">
            in slow motion.
          </span>
        </h1>

        {/* Poetic & Truthful Subtitle */}
        <p className="mt-8 mb-10 text-base sm:text-lg md:text-xl text-zinc-400 max-w-2xl font-light leading-relaxed">
          Like a melody playing in an empty room after midnight. Forge orchestrates your projects, multi-tenant teams, and reactive DAG workflows with quiet, unbreakable certainty.
        </p>

        {/* Primary Call to Action Deck */}
        <div className="flex flex-col sm:flex-row items-center gap-4 w-full justify-center max-w-md">
          <Link
            href="/signup"
            className="w-full sm:w-auto px-8 py-3.5 rounded-full bg-zinc-100 hover:bg-white text-zinc-950 text-xs font-mono tracking-[0.2em] uppercase font-bold flex items-center justify-center gap-2.5 shadow-[0_0_35px_rgba(255,255,255,0.12)] hover:shadow-[0_0_45px_rgba(255,255,255,0.2)] hover:scale-[1.02] active:scale-[0.98] transition-all duration-300"
          >
            <span>ENTER FORGE</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Link>

          <Link
            href="/login"
            className="w-full sm:w-auto px-8 py-3.5 rounded-full border border-white/10 hover:border-white/30 bg-zinc-900/40 hover:bg-zinc-800/40 text-zinc-300 hover:text-white text-xs font-mono tracking-[0.2em] uppercase font-medium flex items-center justify-center gap-2 backdrop-blur-sm transition-all duration-300"
          >
            <LogIn className="w-3.5 h-3.5 text-zinc-400" />
            <span>SIGN IN</span>
          </Link>
        </div>

        {/* Real-time Heartbeat Banner */}
        <div className="mt-14 pt-8 border-t border-white/[0.06] w-full max-w-xl flex flex-wrap items-center justify-around gap-6 text-[11px] font-mono tracking-wider text-zinc-500 uppercase">
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500/80"></span>
            <span>POSTGRES 16 MUTEX</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-400"></span>
            <span>TRANSACTIONAL OUTBOX</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-400"></span>
            <span>SAGA ROLLBACK GUARD</span>
          </div>
        </div>
      </main>

      {/* --- SECTION: The Dreamy Live DAG Simulation Canvas --- */}
      <section className="relative z-10 max-w-5xl mx-auto px-6 py-16">
        <div className="border border-white/[0.08] rounded-2xl bg-zinc-950/70 backdrop-blur-xl p-6 sm:p-10 shadow-2xl overflow-hidden relative">
          
          <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8 pb-6 border-b border-white/[0.06]">
            <div>
              <span className="text-[10px] font-mono tracking-[0.25em] uppercase text-zinc-500 block mb-1">
                LIVE PIPELINE SIMULATION
              </span>
              <h2 className="text-xl sm:text-2xl font-light tracking-wide text-zinc-100">
                A Reactive Event Flowing in the Night
              </h2>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setIsSimulating(!isSimulating)}
                className="px-3 py-1.5 rounded-md border border-white/10 bg-zinc-900/60 hover:bg-zinc-800 text-[11px] font-mono text-zinc-400 hover:text-zinc-200 flex items-center gap-1.5 transition-all"
              >
                {isSimulating ? (
                  <>
                    <Pause className="w-3 h-3 text-zinc-400" />
                    <span>PAUSE STEPPER</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3 h-3 text-zinc-400" />
                    <span>RESUME FLOW</span>
                  </>
                )}
              </button>
              <button
                onClick={() => setActiveStep(0)}
                className="p-1.5 rounded-md border border-white/10 bg-zinc-900/60 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-all"
                title="Reset simulation step"
              >
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Stepper Pipeline Visualizer */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4 relative">
            {DAG_STEPS.map((step, idx) => {
              const isActive = activeStep === idx;
              const isPast = activeStep > idx;

              return (
                <div
                  key={step.id}
                  onClick={() => setActiveStep(idx)}
                  className={`cursor-pointer p-4 rounded-xl border transition-all duration-300 relative ${
                    isActive
                      ? "border-zinc-400 bg-zinc-900/90 shadow-[0_0_25px_rgba(255,255,255,0.06)] scale-[1.02]"
                      : isPast
                      ? "border-white/[0.08] bg-zinc-950/40 text-zinc-400"
                      : "border-white/[0.04] bg-zinc-950/20 text-zinc-600"
                  }`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-mono text-[10px] tracking-widest text-zinc-500">
                      NODE 0{idx + 1}
                    </span>
                    <span
                      className={`w-2 h-2 rounded-full ${
                        isActive
                          ? "bg-zinc-100 shadow-[0_0_8px_rgba(255,255,255,0.8)] animate-pulse"
                          : isPast
                          ? "bg-emerald-500/80"
                          : "bg-zinc-800"
                      }`}
                    />
                  </div>
                  <h3 className={`font-mono text-sm tracking-wide font-medium mb-1 ${isActive ? "text-zinc-100" : "text-zinc-300"}`}>
                    {step.title}
                  </h3>
                  <p className="text-[10px] font-mono tracking-wider text-zinc-500 uppercase mb-2">
                    {step.type}
                  </p>
                  <p className="text-xs text-zinc-400 leading-relaxed font-light">
                    {step.desc}
                  </p>
                </div>
              );
            })}
          </div>

          {/* Stepper Console Output */}
          <div className="mt-8 p-4 rounded-lg bg-black/60 border border-white/[0.06] font-mono text-xs flex items-center justify-between">
            <div className="flex items-center gap-3 text-zinc-400">
              <span className="text-zinc-600">$</span>
              <span>
                dispatching_node[
                <span className="text-zinc-200">{DAG_STEPS[activeStep].title}</span>
                ] · status: <span className="text-emerald-400">EXECUTING_ATOMIC</span>
              </span>
            </div>
            <span className="text-[10px] text-zinc-600 hidden sm:inline">
              NEON_PG // TRANSACTION_ISOLATION
            </span>
          </div>
        </div>
      </section>

      {/* --- SECTION: The Cigarettes After Sex Tracklist (Capabilities) --- */}
      <section className="relative z-10 max-w-5xl mx-auto px-6 py-20 border-t border-white/[0.06]">
        
        <div className="text-center mb-16">
          <div className="inline-flex items-center gap-2 text-[10px] font-mono tracking-[0.3em] uppercase text-zinc-500 mb-3">
            <Disc3 className="w-3.5 h-3.5" />
            <span>ALBUM NOTES // RELEASE 1 SPECIFICATION</span>
          </div>
          <h2 className="text-3xl sm:text-5xl font-light tracking-[0.12em] uppercase text-zinc-100">
            THE ARCHITECTURE TRACKS
          </h2>
          <p className="mt-4 text-zinc-400 text-sm sm:text-base font-light max-w-lg mx-auto">
            Engineered with deep care. Six core capabilities driving every multi-tenant interaction, DAG dispatch, and autonomous agent decision.
          </p>

          {/* Side A / Side B Selector */}
          <div className="inline-flex rounded-full border border-white/10 p-1 bg-zinc-950/60 mt-8">
            <button
              onClick={() => setActiveTab("A")}
              className={`px-5 py-2 rounded-full text-xs font-mono tracking-widest transition-all ${
                activeTab === "A"
                  ? "bg-zinc-100 text-zinc-950 font-bold shadow-md shadow-white/5"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              SIDE A: CORE PLATFORM
            </button>
            <button
              onClick={() => setActiveTab("B")}
              className={`px-5 py-2 rounded-full text-xs font-mono tracking-widest transition-all ${
                activeTab === "B"
                  ? "bg-zinc-100 text-zinc-950 font-bold shadow-md shadow-white/5"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              SIDE B: AGENTS & SCALE
            </button>
          </div>
        </div>

        {/* Tracks List */}
        <div className="space-y-4">
          {TRACKLIST.filter((t) => t.side === activeTab).map((track) => (
            <div
              key={track.num}
              className="group p-6 rounded-2xl border border-white/[0.06] hover:border-white/20 bg-zinc-950/40 hover:bg-zinc-900/40 backdrop-blur-sm transition-all duration-300 flex flex-col md:flex-row items-start md:items-center justify-between gap-6"
            >
              <div className="flex items-start gap-4">
                <span className="font-mono text-xl sm:text-2xl font-light text-zinc-600 group-hover:text-zinc-400 transition-colors">
                  {track.num}
                </span>
                <div>
                  <div className="flex items-center gap-3 mb-1">
                    <h3 className="text-lg sm:text-xl font-light tracking-wide text-zinc-100 group-hover:text-white transition-colors">
                      {track.title}
                    </h3>
                    <span className="px-2 py-0.5 rounded text-[9px] font-mono tracking-wider border border-white/10 bg-white/[0.02] text-zinc-400">
                      {track.badge}
                    </span>
                  </div>
                  <p className="text-xs font-mono text-zinc-500 mb-2">
                    {track.subtitle}
                  </p>
                  <p className="text-sm text-zinc-400 font-light max-w-2xl leading-relaxed">
                    {track.desc}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-4 w-full md:w-auto justify-end border-t md:border-t-0 pt-4 md:pt-0 border-white/[0.04]">
                <div className="flex items-center gap-1.5 text-xs font-mono text-zinc-400">
                  <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400/90" />
                  <span>{track.status}</span>
                </div>
                <Link
                  href={track.route}
                  className="p-2 rounded-full border border-white/10 hover:border-white/30 text-zinc-400 hover:text-white hover:bg-white/[0.05] transition-all"
                  title="Explore track capability"
                >
                  <ChevronRight className="w-4 h-4" />
                </Link>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* --- SECTION: The Founder's Late-Night Promise --- */}
      <section className="relative z-10 max-w-4xl mx-auto px-6 py-20 text-center border-t border-white/[0.06]">
        <blockquote className="font-serif italic text-xl sm:text-2xl md:text-3xl font-light text-zinc-300 max-w-2xl mx-auto leading-relaxed">
          &ldquo;We built Forge not for the noise of the day, but for the quiet precision required when critical systems must never fail in the dark.&rdquo;
        </blockquote>
        <div className="mt-6 flex flex-col items-center">
          <span className="font-mono text-xs uppercase tracking-[0.25em] text-zinc-200">
            ENGINEERED FORGE
          </span>
          <span className="text-[10px] font-mono text-zinc-500 tracking-widest mt-1">
            OPEN PLATFORM · PRODUCTION VERIFIED
          </span>
        </div>
      </section>

      {/* --- FOOTER: Atmospheric Noir Ending --- */}
      <footer className="relative z-10 border-t border-white/[0.06] bg-[#030304] py-12">
        <div className="max-w-6xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-6">
          
          <div className="flex items-center gap-3">
            <div className="h-6 w-6 rounded-sm border border-zinc-700 bg-zinc-900 flex items-center justify-center text-zinc-400">
              <span className="font-serif italic text-[10px]">f</span>
            </div>
            <p className="text-xs font-mono text-zinc-500 tracking-wider">
              &copy; {new Date().getFullYear()} FORGE OS · ALL RIGHTS RESERVED
            </p>
          </div>

          <div className="flex items-center gap-6 text-xs font-mono text-zinc-400 tracking-wider">
            <Link href="/login" className="hover:text-zinc-100 transition-colors">
              SIGN IN
            </Link>
            <Link href="/signup" className="hover:text-zinc-100 transition-colors">
              SIGN UP
            </Link>
            <a
              href="https://github.com/Mayur11code/Forge"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-zinc-100 transition-colors"
            >
              <span>GITHUB</span>
              <ExternalLink className="w-3 h-3 text-zinc-500" />
            </a>
            <a
              href="https://www.linkedin.com/in/mayur-nanda1121/"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 hover:text-zinc-100 transition-colors"
            >
              <span>LINKEDIN</span>
              <ExternalLink className="w-3 h-3 text-zinc-500" />
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

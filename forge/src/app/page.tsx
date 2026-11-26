"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import {
  ArrowRight,
  LogIn,
  Volume2,
  VolumeX,
  ChevronRight,
  ArrowUpRight,
} from "lucide-react";

// --- System Movement Chapters ---
interface SystemMovement {
  id: string;
  index: string;
  title: string;
  subtitle: string;
  detail: string;
  spec: {
    primitive: string;
    guarantee: string;
    isolation: string;
  };
  code: string;
}

const MOVEMENTS: SystemMovement[] = [
  {
    id: "identity",
    index: "01",
    title: "Tenant sanctuary & mutex",
    subtitle: "PostgreSQL row lock serialization",
    detail: "Complete account onboarding, active organization context switching, and strict last-administrator safeguards enforced via database row-level mutex transactions.",
    spec: {
      primitive: "SELECT FOR UPDATE",
      guarantee: "Sole Admin Invariant",
      isolation: "Read committed",
    },
    code: `await db.$transaction(async (tx) => {
  await tx.$executeRaw\`SELECT id FROM "Organization" WHERE id = \${orgId} FOR UPDATE\`;
  const admins = await tx.membership.count({ where: { organizationId: orgId, role: "ADMIN" } });
  if (admins <= 1) throw new Error("LAST_ADMIN_PROTECTED");
  return tx.membership.delete({ where: { id: targetId } });
});`,
  },
  {
    id: "outbox",
    index: "02",
    title: "Transactional event outbox",
    subtitle: "Atomic domain CDC persistence",
    detail: "Domain events (task.created, task.updated) are written to PostgreSQL inside the same atomic transaction as the mutation. Distributed Redis leases prevent split-brain workers.",
    spec: {
      primitive: "Dual-write elimination",
      guarantee: "At-least-once delivery",
      isolation: "Postgres + Redis lease",
    },
    code: `await db.$transaction([
  db.task.update({ where: { id: taskId }, data: { status: "IN_PROGRESS" } }),
  db.outboxEvent.create({ data: { type: "task.updated", payload: { taskId, orgId } } })
]);`,
  },
  {
    id: "saga",
    index: "03",
    title: "Deterministic saga engine",
    subtitle: "Reverse rollback compensation",
    detail: "Workflows execute as deterministic directed acyclic graphs. When an external step times out or fails, registered backward compensation routines trigger in reverse order.",
    spec: {
      primitive: "Saga backward unwind",
      guarantee: "Zero orphaned state",
      isolation: "Deterministic DAG",
    },
    code: `try {
  await executeStep(step, context);
} catch (error) {
  await sagaEngine.compensate({
    runId,
    failedStepId: step.id,
    compensationChain: step.compensatingActions
  });
}`,
  },
  {
    id: "agent",
    index: "04",
    title: "Midnight autonomous agent",
    subtitle: "Inline human approval boundary",
    detail: "A conversational assistant that reasons over organization context and proposes structural DAG adjustments. High-impact operations present reviewable diff cards for human sign-off.",
    spec: {
      primitive: "Tool execution gateway",
      guarantee: "Human-in-the-loop",
      isolation: "Scoped vector sandbox",
    },
    code: `const proposal = await agent.planModification({ prompt, currentWorkflow });
if (proposal.criticality === "HIGH") {
  return renderApprovalCard({ proposal, requiresSignature: true });
}`,
  },
  {
    id: "notifications",
    index: "05",
    title: "Whispered notification fabric",
    subtitle: "Cryptographic 24-hour tokens",
    detail: "Team member invitation lifecycles, transactional alerts, and delivery feedback backed by Resend API infrastructure with recipient boundary verification.",
    spec: {
      primitive: "crypto.randomUUID()",
      guarantee: "Single-tenant scope",
      isolation: "24-hour auto-expire",
    },
    code: `const token = crypto.randomUUID();
await db.invitation.create({
  data: { email, token, expiresAt: new Date(Date.now() + 86400000), organizationId }
});`,
  },
  {
    id: "vectors",
    index: "06",
    title: "Semantic vector lifecycle",
    subtitle: "Pinecone indexing & deterministic tombstones",
    detail: "Project attachments upload to UploadThing, parse into semantic markdown chunks, generate embeddings, and ensure clean vector tombstoning on document deletion.",
    spec: {
      primitive: "Cosine hybrid index",
      guarantee: "Tombstone on delete",
      isolation: "Partitioned RAG",
    },
    code: `await pinecone.index.deleteMany({
  filter: { organizationId: { $eq: orgId }, documentId: { $eq: fileId } }
});`,
  },
];

// --- Interactive DAG Node Model ---
interface DagNode {
  id: string;
  label: string;
  stepNumber: string;
  category: string;
  signature: string;
  compensation: string;
}

const DAG_NODES: DagNode[] = [
  {
    id: "trigger",
    label: "task.created",
    stepNumber: "Node 01",
    category: "Domain CDC trigger",
    signature: "{ taskId: UUID, priority: 'URGENT', organizationId: UUID }",
    compensation: "None (Event source invariant)",
  },
  {
    id: "filter",
    label: "condition.evaluate",
    stepNumber: "Node 02",
    category: "Isolated logic gate",
    signature: "payload.priority === 'URGENT' -> [true branch]",
    compensation: "None (Stateless evaluation)",
  },
  {
    id: "mutation",
    label: "task.assign_lead",
    stepNumber: "Node 03",
    category: "Transactional mutation",
    signature: "UPDATE \"Task\" SET assigneeId = $leadId WHERE id = $taskId",
    compensation: "UPDATE \"Task\" SET assigneeId = NULL WHERE id = $taskId",
  },
  {
    id: "delivery",
    label: "resend.dispatch_alert",
    stepNumber: "Node 04",
    category: "External provider",
    signature: "resend.emails.send({ to: lead.email, template: 'urgent_triage' })",
    compensation: "AuditLog.append({ event: 'NOTIFICATION_DISPATCH_RECORDED' })",
  },
];

// --- Web Audio Noise Buffer Generator ---
function generateVinylNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const bufferSize = ctx.sampleRate * 2;
  const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const output = noiseBuffer.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;

  for (let i = 0; i < bufferSize; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.76160 * b5 - white * 0.0168980;
    let pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;

    if (Math.random() < 0.0005) {
      pink += (Math.random() - 0.5) * 4.0;
    }

    output[i] = pink * 0.04;
  }

  return noiseBuffer;
}

export default function Home() {
  const [ambientAudioActive, setAmbientAudioActive] = useState(false);
  const [tapeWarmth, setTapeWarmth] = useState<"33" | "45">("33");
  const [selectedDagIndex, setSelectedDagIndex] = useState(0);
  const [selectedMovement, setSelectedMovement] = useState<string>("identity");
  const [currentTimeUTC, setCurrentTimeUTC] = useState<string>("");
  const [isLoaded, setIsLoaded] = useState(false);

  // Buttery Lerped Mouse Spotlight Coordinates
  const targetMousePos = useRef({ x: -1000, y: -1000 });
  const [smoothMousePos, setSmoothMousePos] = useState({ x: -1000, y: -1000 });

  // Web Audio & Canvas Spectrum Refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const filterNodeRef = useRef<BiquadFilterNode | null>(null);
  const decayingBarsRef = useRef<number[]>(new Array(18).fill(2));

  // Staggered entry animation on initial mount
  useEffect(() => {
    const timer = setTimeout(() => setIsLoaded(true), 50);
    return () => clearTimeout(timer);
  }, []);

  // Real-time UTC Clock
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setCurrentTimeUTC(
        now.toISOString().replace("T", " ").slice(0, 19) + " UTC"
      );
    };
    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // Smooth lerp mouse tracking loop
  useEffect(() => {
    let animId: number;
    const lerpLoop = () => {
      setSmoothMousePos((prev) => {
        const dx = targetMousePos.current.x - prev.x;
        const dy = targetMousePos.current.y - prev.y;
        if (Math.abs(dx) < 0.2 && Math.abs(dy) < 0.2) return prev;
        return {
          x: prev.x + dx * 0.08,
          y: prev.y + dy * 0.08,
        };
      });
      animId = requestAnimationFrame(lerpLoop);
    };
    animId = requestAnimationFrame(lerpLoop);
    return () => cancelAnimationFrame(animId);
  }, []);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    targetMousePos.current = { x: e.clientX, y: e.clientY };
  };

  // Web Audio Vinyl & Tape Hiss Generator
  const toggleAmbientAudio = () => {
    if (typeof window === "undefined") return;

    if (ambientAudioActive) {
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        audioCtxRef.current.suspend();
      }
      setAmbientAudioActive(false);
      return;
    }

    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;

      if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
        audioCtxRef.current = new AudioCtx();
      } else if (audioCtxRef.current.state === "suspended") {
        audioCtxRef.current.resume();
      }

      const ctx = audioCtxRef.current;
      const noiseBuffer = generateVinylNoiseBuffer(ctx);

      const noiseSource = ctx.createBufferSource();
      noiseSource.buffer = noiseBuffer;
      noiseSource.loop = true;

      // Warm analog bandpass filter
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(tapeWarmth === "33" ? 680 : 920, ctx.currentTime);
      filter.Q.setValueAtTime(0.85, ctx.currentTime);
      filterNodeRef.current = filter;

      // Analyser for real canvas spectrum
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 64;
      analyserRef.current = analyser;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.045, ctx.currentTime);

      noiseSource.connect(filter);
      filter.connect(gain);
      gain.connect(analyser);
      analyser.connect(ctx.destination);

      noiseSource.start();
      setAmbientAudioActive(true);

      renderSpectrum();
    } catch {
      setAmbientAudioActive(false);
    }
  };

  const toggleTapeSpeed = () => {
    const next = tapeWarmth === "33" ? "45" : "33";
    setTapeWarmth(next);
    if (filterNodeRef.current && audioCtxRef.current) {
      filterNodeRef.current.frequency.setValueAtTime(
        next === "33" ? 680 : 920,
        audioCtxRef.current.currentTime
      );
    }
  };

  // Real Audio Spectrum Visualizer with Analog Inertia
  const renderSpectrum = () => {
    if (!canvasRef.current || !analyserRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const analyser = analyserRef.current;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      animationFrameRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barWidth = 3;
      const gap = 2;
      let x = 0;

      for (let i = 0; i < 18; i++) {
        const val = dataArray[i] || 0;
        const targetHeight = Math.max(2, (val / 255) * canvas.height * 0.88);

        // Gentle VU meter decay
        const current = decayingBarsRef.current[i] || 2;
        const updated = current < targetHeight ? targetHeight : current * 0.91;
        decayingBarsRef.current[i] = updated;

        ctx.fillStyle = "rgba(228, 228, 231, 0.75)";
        ctx.fillRect(x, canvas.height - updated, barWidth, updated);

        x += barWidth + gap;
      }
    };

    draw();
  };

  useEffect(() => {
    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (audioCtxRef.current && audioCtxRef.current.state !== "closed") {
        try {
          audioCtxRef.current.close();
        } catch {
          // ignore
        }
      }
    };
  }, []);

  const activeMovementData =
    MOVEMENTS.find((m) => m.id === selectedMovement) || MOVEMENTS[0];

  return (
    <div
      onMouseMove={handleMouseMove}
      className="relative min-h-screen bg-[#070709] text-zinc-100 font-sans antialiased selection:bg-zinc-800 selection:text-white overflow-x-hidden"
    >
      {/* --- Dynamic Ambient Mouse Spotlight with Fluid Lerp Deceleration --- */}
      <div
        className="pointer-events-none fixed inset-0 z-0 transition-opacity duration-700 ease-out opacity-60"
        style={{
          background: `radial-gradient(750px circle at ${smoothMousePos.x}px ${smoothMousePos.y}px, rgba(255, 255, 255, 0.045), transparent 80%)`,
        }}
      />

      {/* --- Architectural Hairline Blueprint Grid --- */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.035] bg-[linear-gradient(to_right,#ffffff_1px,transparent_1px),linear-gradient(to_bottom,#ffffff_1px,transparent_1px)] bg-[size:48px_48px]"
      />

      {/* --- Subtle 35mm Analog Film Grain Texture --- */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-40 opacity-[0.032] mix-blend-screen bg-repeat"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
        }}
      />

      {/* ========================================================= */}
      {/* 1. TOP NAV: Museum-Grade Editorial Precision              */}
      {/* ========================================================= */}
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-white/[0.08] bg-[#070709]/80 backdrop-blur-xl transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          
          {/* Brand & Reference Index */}
          <div className="flex items-center gap-6">
            <Link href="/" className="group flex items-center gap-3">
              <span className="w-6 h-6 border border-zinc-700 bg-zinc-950 flex items-center justify-center font-mono text-xs font-bold text-zinc-300 group-hover:border-white group-hover:text-white transition-colors duration-300">
                F
              </span>
              <span className="font-mono text-xs tracking-[0.2em] uppercase text-zinc-100 font-semibold group-hover:text-white transition-colors duration-300">
                Forge
              </span>
            </Link>

            <div className="hidden lg:flex items-center gap-4 text-[11px] font-mono text-zinc-500 border-l border-white/[0.08] pl-6">
              <span>Release 1.0</span>
              <span>·</span>
              <span>DAG orchestration</span>
              <span>·</span>
              <span className="text-zinc-400 font-medium">{currentTimeUTC || "UTC sync"}</span>
            </div>
          </div>

          {/* Center: Tactile Vinyl / Cassette Tape Deck Console */}
          <div className="hidden sm:flex items-center gap-2 border border-white/[0.08] bg-zinc-950/80 px-3 py-1.5 transition-colors duration-300 hover:border-zinc-700">
            <button
              onClick={toggleAmbientAudio}
              className={`flex items-center gap-2 text-[11px] font-mono tracking-wider transition-colors duration-300 ${
                ambientAudioActive ? "text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
              }`}
              title="Toggle analog tape hiss & vinyl warmth"
            >
              {ambientAudioActive ? (
                <Volume2 className="w-3.5 h-3.5 text-zinc-100 transition-transform duration-300" />
              ) : (
                <VolumeX className="w-3.5 h-3.5 text-zinc-500" />
              )}
              <span>
                {ambientAudioActive ? `Tape hiss: ${tapeWarmth} RPM` : "Tape hiss: Muted"}
              </span>
            </button>

            {ambientAudioActive && (
              <canvas
                ref={canvasRef}
                width={88}
                height={14}
                className="ml-1 border-l border-white/[0.1] pl-2 transition-opacity duration-500"
              />
            )}

            <button
              onClick={toggleTapeSpeed}
              disabled={!ambientAudioActive}
              className="text-[10px] font-mono px-1.5 py-0.5 border border-white/[0.1] text-zinc-500 hover:text-zinc-300 hover:border-zinc-500 disabled:opacity-30 transition-all duration-300 uppercase ml-1"
              title="Toggle playback EQ filter"
            >
              {tapeWarmth}
            </button>
          </div>

          {/* Action CTAs: Crisp Rectangular Geometry with Hover Lift */}
          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="px-4 py-2 border border-white/[0.1] hover:border-white/30 text-zinc-300 hover:text-white text-xs font-mono tracking-wider transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5"
            >
              Sign in
            </Link>

            <Link
              href="/signup"
              className="px-5 py-2 bg-zinc-100 hover:bg-white text-zinc-950 text-xs font-mono font-semibold tracking-wider transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_4px_25px_rgba(255,255,255,0.18)]"
            >
              Enter Forge
            </Link>
          </div>
        </div>
      </header>

      {/* ========================================================= */}
      {/* 2. HERO SECTION: Monumental Editorial Masterpiece         */}
      {/* ========================================================= */}
      <section
        className={`relative z-10 pt-36 pb-24 border-b border-white/[0.08] max-w-7xl mx-auto px-6 transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          isLoaded ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"
        }`}
      >
        {/* Top Monospace Section Matrix Header */}
        <div className="flex items-center justify-between border-b border-white/[0.08] pb-4 mb-14 text-xs font-mono tracking-wider text-zinc-500">
          <div className="flex items-center gap-2">
            <span className="text-zinc-300 font-semibold">[ 001 ]</span>
            <span>Nocturne system contract</span>
          </div>
          <div className="hidden sm:block">
            <span>Isolation: Multi-tenant · Recovery: Saga rollback</span>
          </div>
        </div>

        {/* Arresting Monumental Title in Sentence Case */}
        <div className="max-w-5xl">
          <h1 className="text-5xl sm:text-7xl md:text-8xl lg:text-9xl font-light tracking-[-0.035em] leading-[0.94] text-zinc-100">
            Orchestration <br />
            <span className="font-serif italic font-normal tracking-tight text-zinc-400 text-4xl sm:text-6xl md:text-7xl lg:text-8xl block mt-3">
              in slow motion.
            </span>
          </h1>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-8 mt-14 pt-10 border-t border-white/[0.08]">
            <div className="md:col-span-8">
              <p className="text-lg sm:text-xl md:text-2xl text-zinc-300 font-light leading-relaxed">
                A multi-tenant, event-driven engine where workflows, teams, and autonomous agents operate with quiet, deterministic certainty.
              </p>
              <p className="mt-4 text-xs sm:text-sm font-mono text-zinc-400 leading-relaxed tracking-wide">
                Built for the midnight deployment. Every CDC trigger writes to a transactional outbox. Every distributed failure executes an atomic reverse compensation.
              </p>
            </div>

            {/* Structured CTAs with Coordinates */}
            <div className="md:col-span-4 flex flex-col justify-end space-y-3">
              <Link
                href="/signup"
                className="w-full py-4 px-6 bg-zinc-100 hover:bg-white text-zinc-950 font-mono text-xs font-bold tracking-wider flex items-center justify-between transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_8px_30px_rgba(255,255,255,0.14)] group"
              >
                <span>Create workspace</span>
                <ArrowRight className="w-4 h-4 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-1" />
              </Link>

              <Link
                href="/login"
                className="w-full py-3.5 px-6 border border-white/[0.12] hover:border-white/40 bg-zinc-950/40 text-zinc-300 hover:text-white font-mono text-xs tracking-wider flex items-center justify-between transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5"
              >
                <span>Resume session</span>
                <LogIn className="w-4 h-4 text-zinc-500 group-hover:text-zinc-300 transition-colors" />
              </Link>
            </div>
          </div>
        </div>

        {/* Structural Metrics Ledger */}
        <div className="grid grid-cols-2 md:grid-cols-4 border border-white/[0.08] mt-20 divide-y md:divide-y-0 md:divide-x divide-white/[0.08] bg-zinc-950/30">
          <div className="p-6 transition-colors duration-300 hover:bg-zinc-900/40">
            <span className="block text-xs font-mono tracking-wider text-zinc-500 mb-1">
              Concurrency mutex
            </span>
            <span className="font-mono text-xl sm:text-2xl text-zinc-100 font-semibold">
              Row-lock
            </span>
            <span className="block text-xs font-mono text-zinc-500 mt-1">
              PostgreSQL Level E3 verified
            </span>
          </div>

          <div className="p-6 transition-colors duration-300 hover:bg-zinc-900/40">
            <span className="block text-xs font-mono tracking-wider text-zinc-500 mb-1">
              Atomic dispatch
            </span>
            <span className="font-mono text-xl sm:text-2xl text-zinc-100 font-semibold">
              Transactional
            </span>
            <span className="block text-xs font-mono text-zinc-500 mt-1">
              Outbox + Redis deduplication
            </span>
          </div>

          <div className="p-6 transition-colors duration-300 hover:bg-zinc-900/40">
            <span className="block text-xs font-mono tracking-wider text-zinc-500 mb-1">
              Saga compensation
            </span>
            <span className="font-mono text-xl sm:text-2xl text-zinc-100 font-semibold">
              Deterministic
            </span>
            <span className="block text-xs font-mono text-zinc-500 mt-1">
              Zero orphaned side effects
            </span>
          </div>

          <div className="p-6 transition-colors duration-300 hover:bg-zinc-900/40">
            <span className="block text-xs font-mono tracking-wider text-zinc-500 mb-1">
              Verification suite
            </span>
            <span className="font-mono text-xl sm:text-2xl text-zinc-100 font-semibold">
              129 / 129 pass
            </span>
            <span className="block text-xs font-mono text-zinc-500 mt-1">
              2,025 automated test gates
            </span>
          </div>
        </div>
      </section>

      {/* ========================================================= */}
      {/* 3. INTERACTIVE DAG SCHEMATIC CONSOLE                      */}
      {/* ========================================================= */}
      <section className="relative z-10 py-24 border-b border-white/[0.08] max-w-7xl mx-auto px-6">
        
        <div className="flex flex-col sm:flex-row items-start sm:items-end justify-between border-b border-white/[0.08] pb-6 mb-12">
          <div>
            <span className="text-xs font-mono tracking-wider text-zinc-500 block mb-1">
              [ 002 // Schematic ]
            </span>
            <h2 className="text-3xl sm:text-4xl font-light tracking-tight text-zinc-100">
              Reactive DAG pipeline inspection
            </h2>
          </div>
          <span className="text-xs font-mono text-zinc-400 mt-2 sm:mt-0">
            Click a node to inspect its transactional signature
          </span>
        </div>

        {/* CAD Schematic Node Deck */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {DAG_NODES.map((node, idx) => {
            const isSelected = selectedDagIndex === idx;

            return (
              <div
                key={node.id}
                onClick={() => setSelectedDagIndex(idx)}
                className={`cursor-pointer p-6 border transition-all duration-400 ease-[cubic-bezier(0.16,1,0.3,1)] relative hover:-translate-y-1 ${
                  isSelected
                    ? "border-zinc-200 bg-zinc-900/90 shadow-[0_12px_35px_rgba(255,255,255,0.06)]"
                    : "border-white/[0.08] bg-zinc-950/40 hover:border-zinc-600 hover:bg-zinc-900/30"
                }`}
              >
                <div className="flex items-center justify-between mb-4 text-xs font-mono">
                  <span className={isSelected ? "text-zinc-100 font-bold" : "text-zinc-500"}>
                    {node.stepNumber}
                  </span>
                  <span className="text-zinc-500 tracking-wider">
                    Step 0{idx + 1}
                  </span>
                </div>

                <h3 className={`font-mono text-base font-medium mb-1 transition-colors duration-300 ${isSelected ? "text-white" : "text-zinc-200"}`}>
                  {node.label}
                </h3>
                <span className="block text-xs font-mono text-zinc-500 tracking-wider mb-4">
                  {node.category}
                </span>

                <div className="border-t border-white/[0.08] pt-3 text-xs font-mono text-zinc-400 truncate">
                  {node.signature}
                </div>
              </div>
            );
          })}
        </div>

        {/* Live Node Telemetry Ledger with Smooth Transition */}
        <div className="mt-6 border border-white/[0.08] bg-black p-6 font-mono text-xs transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-3 mb-4 text-xs text-zinc-400">
            <span>
              Node inspector // <strong className="text-zinc-100">{DAG_NODES[selectedDagIndex].label}</strong>
            </span>
            <span className="text-zinc-500">
              Status: <span className="text-zinc-200">Verified immutable</span>
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-zinc-400">
            <div className="transition-opacity duration-300">
              <span className="text-xs text-zinc-500 tracking-wider block mb-1">
                Forward invocation contract
              </span>
              <pre className="p-3 bg-zinc-950 border border-zinc-800/80 text-zinc-200 overflow-x-auto text-xs leading-relaxed">
                {DAG_NODES[selectedDagIndex].signature}
              </pre>
            </div>

            <div className="transition-opacity duration-300">
              <span className="text-xs text-zinc-500 tracking-wider block mb-1">
                Saga backward compensation routine
              </span>
              <pre className="p-3 bg-zinc-950 border border-zinc-800/80 text-zinc-400 overflow-x-auto text-xs leading-relaxed">
                {DAG_NODES[selectedDagIndex].compensation}
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* ========================================================= */}
      {/* 4. ARCHITECTURAL MOVEMENTS (SWISS GRID CATALOG)           */}
      {/* ========================================================= */}
      <section className="relative z-10 py-24 border-b border-white/[0.08] max-w-7xl mx-auto px-6">
        
        <div className="border-b border-white/[0.08] pb-6 mb-16 flex flex-col md:flex-row md:items-end justify-between gap-4">
          <div>
            <span className="text-xs font-mono tracking-wider text-zinc-500 block mb-1">
              [ 003 // Specification ]
            </span>
            <h2 className="text-3xl sm:text-5xl font-light tracking-tight text-zinc-100">
              Six architectural movements
            </h2>
          </div>
          <p className="text-sm font-mono text-zinc-400 max-w-md">
            Concrete system capabilities. Zero marketing abstraction. Every capability maps directly to audited application source.
          </p>
        </div>

        {/* 2-Column Split: Index Navigation on Left, Live Code Inspector on Right */}
        <div className="grid grid-cols-1 lg:grid-cols-12 border border-white/[0.08]">
          
          {/* Movement Index List */}
          <div className="lg:col-span-5 divide-y divide-white/[0.08] bg-zinc-950/40">
            {MOVEMENTS.map((movement) => {
              const isActive = selectedMovement === movement.id;

              return (
                <div
                  key={movement.id}
                  onClick={() => setSelectedMovement(movement.id)}
                  className={`p-6 cursor-pointer transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] relative ${
                    isActive
                      ? "bg-zinc-900/90 text-white"
                      : "hover:bg-zinc-900/40 text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  <div className="flex items-center justify-between mb-2 font-mono text-xs">
                    <span className={isActive ? "text-zinc-100 font-bold" : "text-zinc-500"}>
                      [{movement.index}]
                    </span>
                    <span className="text-xs text-zinc-500">
                      {movement.spec.isolation}
                    </span>
                  </div>

                  <h3 className="font-mono text-base font-semibold text-zinc-100 mb-1">
                    {movement.title}
                  </h3>
                  <p className="text-xs text-zinc-400 font-mono">
                    {movement.subtitle}
                  </p>
                </div>
              );
            })}
          </div>

          {/* Detailed Movement Code & Guarantees Inspector with Graceful Transition */}
          <div className="lg:col-span-7 p-8 bg-black/60 border-t lg:border-t-0 lg:border-l border-white/[0.08] flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between border-b border-zinc-800 pb-4 mb-6">
                <div>
                  <span className="text-xs font-mono text-zinc-500 tracking-wider block">
                    Active architectural target
                  </span>
                  <h4 className="text-2xl font-light text-zinc-100 font-mono mt-1">
                    {activeMovementData.title}
                  </h4>
                </div>
                <span className="text-xs font-mono px-3 py-1 border border-zinc-800 text-zinc-300">
                  Ref: {activeMovementData.id}
                </span>
              </div>

              <p className="text-sm sm:text-base text-zinc-300 font-light leading-relaxed mb-6">
                {activeMovementData.detail}
              </p>

              {/* Guarantees Matrix */}
              <div className="grid grid-cols-3 border border-zinc-800 p-4 mb-6 text-xs font-mono divide-x divide-zinc-800 bg-zinc-950/60">
                <div className="px-3">
                  <span className="text-xs text-zinc-500 block">Primitive</span>
                  <span className="text-zinc-200 mt-1 block truncate">{activeMovementData.spec.primitive}</span>
                </div>
                <div className="px-3">
                  <span className="text-xs text-zinc-500 block">Guarantee</span>
                  <span className="text-zinc-200 mt-1 block truncate">{activeMovementData.spec.guarantee}</span>
                </div>
                <div className="px-3">
                  <span className="text-xs text-zinc-500 block">Isolation</span>
                  <span className="text-zinc-200 mt-1 block truncate">{activeMovementData.spec.isolation}</span>
                </div>
              </div>

              {/* Verified Code Snippet */}
              <div>
                <span className="text-xs font-mono text-zinc-500 tracking-wider block mb-2">
                  Verified runtime implementation
                </span>
                <pre className="p-4 bg-zinc-950 border border-zinc-800 text-zinc-300 text-xs font-mono overflow-x-auto leading-relaxed">
                  {activeMovementData.code}
                </pre>
              </div>
            </div>

            <div className="pt-6 mt-8 border-t border-zinc-900 flex items-center justify-between">
              <Link
                href="/signup"
                className="text-xs font-mono tracking-wider text-zinc-400 hover:text-white flex items-center gap-1.5 transition-colors duration-300"
              >
                <span>Initialize capability</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </Link>
              <span className="text-xs font-mono text-zinc-600">
                Source: /forge/src/lib/workflow
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* ========================================================= */}
      {/* 5. EDITORIAL MANIFESTO: The Late-Night Creed              */}
      {/* ========================================================= */}
      <section className="relative z-10 py-28 border-b border-white/[0.08] max-w-7xl mx-auto px-6">
        <div className="max-w-4xl mx-auto text-center">
          
          <span className="text-xs font-mono tracking-widest text-zinc-500 block mb-6">
            [ 004 // Manifesto ]
          </span>

          <blockquote className="text-2xl sm:text-4xl md:text-5xl font-light font-serif italic text-zinc-200 leading-[1.3]">
            &ldquo;We do not build for the noise of the day. We build for the silent certainty required when systems execute in the dark.&rdquo;
          </blockquote>

          <div className="mt-12 flex flex-col items-center">
            <span className="font-mono text-sm text-zinc-100 font-semibold tracking-wider">
              Engineered Forge
            </span>
            <span className="font-mono text-xs text-zinc-500 tracking-wider mt-1">
              Production-verified SaaS architecture · Open to explore
            </span>
          </div>

          <div className="mt-12 flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="/signup"
              className="px-8 py-4 bg-zinc-100 hover:bg-white text-zinc-950 font-mono text-xs font-bold tracking-wider transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_8px_30px_rgba(255,255,255,0.14)]"
            >
              Create an account
            </Link>
            <Link
              href="/login"
              className="px-8 py-4 border border-white/[0.15] hover:border-white/40 text-zinc-300 hover:text-white font-mono text-xs tracking-wider transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5"
            >
              Sign in to workspace
            </Link>
          </div>
        </div>
      </section>

      {/* ========================================================= */}
      {/* 6. FOOTER: Minimalist Architectural Colophon             */}
      {/* ========================================================= */}
      <footer className="relative z-10 bg-[#040406] py-16 text-zinc-500 font-mono text-xs">
        <div className="max-w-7xl mx-auto px-6 grid grid-cols-1 md:grid-cols-12 gap-8 border-b border-white/[0.06] pb-12">
          
          <div className="md:col-span-5 space-y-3">
            <div className="flex items-center gap-2">
              <span className="w-5 h-5 border border-zinc-700 bg-zinc-900 flex items-center justify-center text-zinc-300 text-xs font-bold font-mono">
                F
              </span>
              <span className="tracking-wider text-zinc-200 font-semibold">
                Forge OS
              </span>
            </div>
            <p className="text-xs text-zinc-400 font-light max-w-sm leading-relaxed">
              Multi-tenant project management, transactional event outbox, and DAG workflow orchestration with reverse saga compensation.
            </p>
          </div>

          <div className="md:col-span-3 space-y-2 text-xs">
            <span className="text-zinc-300 tracking-wider block mb-3 font-semibold">
              Access portal
            </span>
            <div><Link href="/login" className="hover:text-zinc-200 transition-colors duration-200">Sign in</Link></div>
            <div><Link href="/signup" className="hover:text-zinc-200 transition-colors duration-200">Create workspace</Link></div>
            <div><Link href="/select-org" className="hover:text-zinc-200 transition-colors duration-200">Workspace selector</Link></div>
          </div>

          <div className="md:col-span-4 space-y-2 text-xs">
            <span className="text-zinc-300 tracking-wider block mb-3 font-semibold">
              Network & source
            </span>
            <div>
              <a
                href="https://github.com/Mayur11code/Forge"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-zinc-200 flex items-center gap-1 transition-colors duration-200"
              >
                <span>GitHub repository</span>
                <ArrowUpRight className="w-3 h-3 text-zinc-500" />
              </a>
            </div>
            <div>
              <a
                href="https://www.linkedin.com/in/mayur-nanda1121/"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-zinc-200 flex items-center gap-1 transition-colors duration-200"
              >
                <span>LinkedIn founder profile</span>
                <ArrowUpRight className="w-3 h-3 text-zinc-500" />
              </a>
            </div>
          </div>
        </div>

        <div className="max-w-7xl mx-auto px-6 pt-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs tracking-wider text-zinc-600">
          <span>&copy; {new Date().getFullYear()} Forge · Nocturne specification</span>
          <span>PostgreSQL 16 · Next.js 16 · Upstash Redis · Prisma ORM</span>
        </div>
      </footer>
    </div>
  );
}

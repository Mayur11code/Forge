"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import {
  ArrowRight,
  LogIn,
  Volume2,
  VolumeX,
  Play,
  Pause,
  ChevronRight,
  ArrowUpRight,
} from "lucide-react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

// Register ScrollTrigger safely in browser context
if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger);
}

// --- System Chapters (Kind 50 / Bizarro Narrative Architecture) ---
interface SystemChapter {
  id: string;
  index: string;
  title: string;
  subtitle: string;
  detail: string;
  quote: string;
  metrics: { label: string; value: string }[];
  code: string;
}

const CHAPTERS: SystemChapter[] = [
  {
    id: "identity",
    index: "01",
    title: "Tenant sanctuary & mutex",
    subtitle: "PostgreSQL row lock serialization",
    detail: "Complete account onboarding, active organization context switching, and strict last-administrator safeguards enforced via database row-level mutex transactions.",
    quote: "A team should never be left without an anchor. Row locks guarantee exactly one admin always remains.",
    metrics: [
      { label: "Primitive", value: "SELECT FOR UPDATE" },
      { label: "Isolation", value: "Read committed" },
      { label: "Guarantee", value: "Sole admin invariant" },
    ],
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
    quote: "No ghost events. If the database rolls back, the event was never born.",
    metrics: [
      { label: "Outbox pattern", value: "Dual-write elimination" },
      { label: "Delivery", value: "At-least-once" },
      { label: "Lock mechanism", value: "Redis lease mutex" },
    ],
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
    quote: "When distributed steps break in the night, the engine walks back its footprints clean.",
    metrics: [
      { label: "Topology", value: "Deterministic DAG" },
      { label: "Rollback", value: "Reverse saga chain" },
      { label: "Side effects", value: "Zero orphaned state" },
    ],
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
    quote: "Intelligence that asks before it cuts. Critical migrations require human touch.",
    metrics: [
      { label: "Execution model", value: "Tool proposal gateway" },
      { label: "Safety tier", value: "Human-in-the-loop" },
      { label: "Memory", value: "Scoped vector sandbox" },
    ],
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
    quote: "Invitations that respect borders. Tokens expire like milk at dawn.",
    metrics: [
      { label: "Token entropy", value: "crypto.randomUUID()" },
      { label: "TTL lifespan", value: "24-hour auto-expire" },
      { label: "Scope", value: "Single-tenant boundary" },
    ],
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
    quote: "A system that forgets on command. Deleting a document wipes its ghost from vector space.",
    metrics: [
      { label: "Search index", value: "Cosine hybrid vector" },
      { label: "Chunking", value: "Semantic boundary" },
      { label: "Tombstoning", value: "Synchronous delete" },
    ],
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
  const [activeChapterIndex, setActiveChapterIndex] = useState(0);
  const [currentTimeUTC, setCurrentTimeUTC] = useState<string>("");
  const [isLoaded, setIsLoaded] = useState(false);
  const [tapeCounter, setTapeCounter] = useState(14);
  const [isHoveringCassette, setIsHoveringCassette] = useState(false);
  const [horizontalProgress, setHorizontalProgress] = useState(0);

  // Section Refs for GSAP ScrollTrigger
  const heroRef = useRef<HTMLElement | null>(null);
  const cassetteContainerRef = useRef<HTMLDivElement | null>(null);
  const chaptersContainerRef = useRef<HTMLDivElement | null>(null);
  const chaptersTrackRef = useRef<HTMLDivElement | null>(null);
  const dagSectionRef = useRef<HTMLElement | null>(null);

  // Buttery Lerped Mouse Coordinates for Spotlight & Cassette 3D Tilt
  const targetMousePos = useRef({ x: 0, y: 0 });
  const [smoothMousePos, setSmoothMousePos] = useState({ x: 0, y: 0 });
  const [cassetteTilt, setCassetteTilt] = useState({ rotX: 0, rotY: 0 });

  // Web Audio & Canvas Spectrum Refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cassetteCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const filterNodeRef = useRef<BiquadFilterNode | null>(null);
  const decayingBarsRef = useRef<number[]>(new Array(18).fill(2));
  const spoolAngleRef = useRef(0);

  // Staggered entry animation on mount
  useEffect(() => {
    const timer = setTimeout(() => setIsLoaded(true), 40);
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

  // Tape Counter Clock
  useEffect(() => {
    if (!ambientAudioActive) return;
    const interval = setInterval(() => {
      setTapeCounter((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [ambientAudioActive]);

  // Smooth lerp mouse tracking loop for spotlight and 3D perspective
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

      if (typeof window !== "undefined") {
        const cx = window.innerWidth / 2;
        const cy = window.innerHeight / 2;
        const rotY = ((targetMousePos.current.x - cx) / cx) * 12;
        const rotX = -((targetMousePos.current.y - cy) / cy) * 12;
        setCassetteTilt((prev) => ({
          rotX: prev.rotX + (rotX - prev.rotX) * 0.06,
          rotY: prev.rotY + (rotY - prev.rotY) * 0.06,
        }));
      }

      animId = requestAnimationFrame(lerpLoop);
    };
    animId = requestAnimationFrame(lerpLoop);
    return () => cancelAnimationFrame(animId);
  }, []);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    targetMousePos.current = { x: e.clientX, y: e.clientY };
  };

  // --- Lenis & GSAP ScrollTrigger Master Scroll Choreography ---
  useEffect(() => {
    if (typeof window === "undefined") return;

    // 1. Initialize Lenis Smooth Inertial Scrolling
    const lenis = new Lenis({
      duration: 1.25,
      easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      smoothWheel: true,
      touchMultiplier: 1.8,
    });

    lenis.on("scroll", ScrollTrigger.update);

    const tickerCallback = (time: number) => {
      lenis.raf(time * 1000);
    };

    gsap.ticker.add(tickerCallback);
    gsap.ticker.lagSmoothing(0);

    // 2. Parallax Blueprint Grid Movement
    gsap.to(".parallax-bg-grid", {
      y: -120,
      ease: "none",
      scrollTrigger: {
        trigger: "body",
        start: "top top",
        end: "bottom bottom",
        scrub: true,
      },
    });

    // 3. Hero Cassette 3D Scrub & Spool Acceleration
    const cassette = cassetteContainerRef.current;
    if (cassette && heroRef.current) {
      gsap.to(cassette, {
        y: 80,
        scale: 0.9,
        rotationZ: -4,
        opacity: 0.85,
        ease: "power1.out",
        scrollTrigger: {
          trigger: heroRef.current,
          start: "top top",
          end: "bottom top",
          scrub: true,
          onUpdate: (self) => {
            spoolAngleRef.current += Math.abs(self.getVelocity() * 0.0006);
          },
        },
      });
    }

    // 4. Kind 50-Style Pinned Horizontal Chapter Runway Scroll
    const track = chaptersTrackRef.current;
    const container = chaptersContainerRef.current;
    if (track && container) {
      const getScrollAmount = () => track.scrollWidth - window.innerWidth + 96;

      const horizontalTween = gsap.to(track, {
        x: () => -getScrollAmount(),
        ease: "none",
        scrollTrigger: {
          trigger: container,
          pin: true,
          scrub: 1,
          start: "top top",
          end: () => `+=${getScrollAmount()}`,
          invalidateOnRefresh: true,
          onUpdate: (self) => {
            setHorizontalProgress(self.progress);
            const idx = Math.min(
              CHAPTERS.length - 1,
              Math.floor(self.progress * CHAPTERS.length)
            );
            setActiveChapterIndex(idx);
          },
        },
      });

      return () => {
        horizontalTween.kill();
        lenis.destroy();
        gsap.ticker.remove(tickerCallback);
        ScrollTrigger.getAll().forEach((t) => t.kill());
      };
    }

    return () => {
      lenis.destroy();
      gsap.ticker.remove(tickerCallback);
      ScrollTrigger.getAll().forEach((t) => t.kill());
    };
  }, []);

  // --- Scroll-Driven DAG Sequence Telemetry Trigger ---
  useEffect(() => {
    if (typeof window === "undefined") return;
    const dagSection = dagSectionRef.current;
    if (!dagSection) return;

    const trigger = ScrollTrigger.create({
      trigger: dagSection,
      start: "top 65%",
      end: "bottom 35%",
      scrub: true,
      onUpdate: (self) => {
        const nodeIdx = Math.min(
          DAG_NODES.length - 1,
          Math.floor(self.progress * DAG_NODES.length)
        );
        setSelectedDagIndex(nodeIdx);
      },
    });

    return () => {
      trigger.kill();
    };
  }, []);

  // --- Bizarro-Inspired 3D Interactive Cassette Canvas Renderer ---
  useEffect(() => {
    const canvas = cassetteCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;

    const renderCassette = () => {
      animId = requestAnimationFrame(renderCassette);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      if (ambientAudioActive) {
        spoolAngleRef.current += tapeWarmth === "33" ? 0.035 : 0.055;
      }

      const w = canvas.width;
      const h = canvas.height;
      const centerX = w / 2;
      const centerY = h / 2;

      ctx.save();
      ctx.translate(centerX, centerY);

      // Shell body
      ctx.fillStyle = "#0c0c10";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.roundRect(-170, -110, 340, 220, 8);
      ctx.fill();
      ctx.stroke();

      // Inner Label Area
      ctx.fillStyle = "#14141c";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
      ctx.beginPath();
      ctx.roundRect(-145, -90, 290, 180, 4);
      ctx.fill();
      ctx.stroke();

      // Top label brand line
      ctx.fillStyle = "rgba(255, 255, 255, 0.85)";
      ctx.font = "bold 10px monospace";
      ctx.letterSpacing = "2px";
      ctx.fillText("FORGE // NOCTURNE C-90", -130, -70);

      ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
      ctx.font = "9px monospace";
      ctx.fillText(tapeWarmth === "33" ? "SIDE A · 33⅓ RPM" : "SIDE A · 45 RPM", 40, -70);

      // Center Tape Window cutout
      ctx.fillStyle = "#08080b";
      ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
      ctx.beginPath();
      ctx.roundRect(-100, -35, 200, 70, 4);
      ctx.fill();
      ctx.stroke();

      // Connecting Magnetic Tape ribbon
      ctx.strokeStyle = "#40342b";
      ctx.lineWidth = 12;
      ctx.beginPath();
      ctx.moveTo(-50, 0);
      ctx.lineTo(50, 0);
      ctx.stroke();

      // Left & Right Spools
      const drawSpool = (x: number, angle: number, radius: number) => {
        ctx.save();
        ctx.translate(x, 0);

        ctx.fillStyle = "#33261f";
        ctx.beginPath();
        ctx.arc(0, 0, radius, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = "#ededed";
        ctx.beginPath();
        ctx.arc(0, 0, 16, 0, Math.PI * 2);
        ctx.fill();

        ctx.rotate(angle);
        ctx.strokeStyle = "#08080b";
        ctx.lineWidth = 2.5;
        for (let i = 0; i < 6; i++) {
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(0, -14);
          ctx.stroke();
          ctx.rotate((Math.PI * 2) / 6);
        }

        ctx.fillStyle = "#08080b";
        ctx.beginPath();
        ctx.arc(0, 0, 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.restore();
      };

      drawSpool(-50, spoolAngleRef.current, 28);
      drawSpool(50, spoolAngleRef.current, 22);

      // Bottom screws & guide pins
      ctx.fillStyle = "#262630";
      ctx.beginPath();
      ctx.arc(-150, 90, 3, 0, Math.PI * 2);
      ctx.arc(150, 90, 3, 0, Math.PI * 2);
      ctx.arc(-150, -90, 3, 0, Math.PI * 2);
      ctx.arc(150, -90, 3, 0, Math.PI * 2);
      ctx.fill();

      // Bottom Trapezoid head-window
      ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
      ctx.beginPath();
      ctx.moveTo(-75, 90);
      ctx.lineTo(-55, 110);
      ctx.lineTo(55, 110);
      ctx.lineTo(75, 90);
      ctx.stroke();

      ctx.restore();
    };

    renderCassette();

    return () => {
      cancelAnimationFrame(animId);
    };
  }, [ambientAudioActive, tapeWarmth]);

  // Real Audio Spectrum Visualizer with Analog Inertia
  const renderSpectrum = useCallback(() => {
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

        const current = decayingBarsRef.current[i] || 2;
        const updated = current < targetHeight ? targetHeight : current * 0.91;
        decayingBarsRef.current[i] = updated;

        ctx.fillStyle = "rgba(228, 228, 231, 0.75)";
        ctx.fillRect(x, canvas.height - updated, barWidth, updated);

        x += barWidth + gap;
      }
    };

    draw();
  }, []);

  // Web Audio Vinyl & Tape Hiss Generator
  const toggleAmbientAudio = useCallback(() => {
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

      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.setValueAtTime(tapeWarmth === "33" ? 680 : 920, ctx.currentTime);
      filter.Q.setValueAtTime(0.85, ctx.currentTime);
      filterNodeRef.current = filter;

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
  }, [ambientAudioActive, tapeWarmth, renderSpectrum]);

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

      {/* --- Architectural Hairline Blueprint Grid with Parallax Scrub --- */}
      <div
        aria-hidden="true"
        className="parallax-bg-grid pointer-events-none fixed inset-0 z-0 opacity-[0.035] bg-[linear-gradient(to_right,#ffffff_1px,transparent_1px),linear-gradient(to_bottom,#ffffff_1px,transparent_1px)] bg-[size:48px_48px]"
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
      {/* 1. TOP NAV: Museum-Grade Precision Navigation             */}
      {/* ========================================================= */}
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-white/[0.08] bg-[#070709]/80 backdrop-blur-xl transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          
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

          {/* Sound Deck Quick Control in Nav */}
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
                <VolumeX className="w-3.5 h-3.5" />
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

          {/* Action CTAs */}
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
      {/* 2. HERO SECTION: Bizarro Pinned Cassette & Editorial Hero */}
      {/* ========================================================= */}
      <section
        ref={heroRef}
        className={`relative z-10 pt-32 pb-24 border-b border-white/[0.08] max-w-7xl mx-auto px-6 transition-all duration-1000 ease-[cubic-bezier(0.16,1,0.3,1)] ${
          isLoaded ? "opacity-100 translate-y-0" : "opacity-0 translate-y-6"
        }`}
      >
        <div className="flex items-center justify-between border-b border-white/[0.08] pb-4 mb-12 text-xs font-mono tracking-wider text-zinc-500">
          <div className="flex items-center gap-2">
            <span className="text-zinc-300 font-semibold">[ 001 ]</span>
            <span>Nocturne system contract</span>
          </div>
          <div className="hidden sm:block">
            <span>Isolation: Multi-tenant · Recovery: Saga rollback</span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
          
          <div className="lg:col-span-7">
            <h1 className="text-5xl sm:text-7xl md:text-8xl lg:text-9xl font-light tracking-[-0.035em] leading-[0.94] text-zinc-100">
              Orchestration <br />
              <span className="font-serif italic font-normal tracking-tight text-zinc-400 text-4xl sm:text-6xl md:text-7xl lg:text-8xl block mt-3">
                in slow motion.
              </span>
            </h1>

            <p className="text-lg sm:text-xl text-zinc-300 font-light leading-relaxed mt-10 max-w-xl">
              A multi-tenant, event-driven engine where workflows, teams, and autonomous agents operate with quiet, deterministic certainty.
            </p>
            <p className="mt-4 text-xs sm:text-sm font-mono text-zinc-400 leading-relaxed max-w-lg">
              Built for the midnight deployment. Every CDC trigger writes to a transactional outbox. Every distributed failure executes an atomic reverse compensation.
            </p>

            <div className="flex flex-col sm:flex-row items-center gap-4 mt-10">
              <Link
                href="/signup"
                className="w-full sm:w-auto py-4 px-8 bg-zinc-100 hover:bg-white text-zinc-950 font-mono text-xs font-bold tracking-wider flex items-center justify-center gap-3 transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_8px_30px_rgba(255,255,255,0.14)] group"
              >
                <span>Create workspace</span>
                <ArrowRight className="w-4 h-4 transition-transform duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] group-hover:translate-x-1" />
              </Link>

              <Link
                href="/login"
                className="w-full sm:w-auto py-4 px-8 border border-white/[0.12] hover:border-white/40 bg-zinc-950/40 text-zinc-300 hover:text-white font-mono text-xs tracking-wider flex items-center justify-center gap-2 transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5"
              >
                <span>Resume session</span>
                <LogIn className="w-4 h-4 text-zinc-500" />
              </Link>
            </div>
          </div>

          {/* Right: Bizarro 3D Cassette Deck with Scroll Scrub Reaction */}
          <div className="lg:col-span-5 flex flex-col items-center justify-center">
            <div
              ref={cassetteContainerRef}
              onMouseEnter={() => setIsHoveringCassette(true)}
              onMouseLeave={() => setIsHoveringCassette(false)}
              style={{
                perspective: "1000px",
              }}
              className="relative w-full max-w-[380px] p-6 border border-white/[0.08] bg-zinc-950/70 backdrop-blur-md shadow-2xl transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] hover:border-zinc-500"
            >
              <div
                style={{
                  transform: `rotateX(${cassetteTilt.rotX}deg) rotateY(${cassetteTilt.rotY}deg)`,
                  transformStyle: "preserve-3d",
                  transition: isHoveringCassette ? "none" : "transform 0.6s cubic-bezier(0.16, 1, 0.3, 1)",
                }}
                className="relative flex flex-col items-center"
              >
                <canvas
                  ref={cassetteCanvasRef}
                  width={360}
                  height={240}
                  className="w-full h-auto cursor-pointer"
                  onClick={toggleAmbientAudio}
                  title="Click to spin tape & play ambient warmth"
                />

                <div className="w-full mt-4 pt-4 border-t border-white/[0.08] flex items-center justify-between text-xs font-mono">
                  <div className="flex items-center gap-2 text-zinc-400">
                    <button
                      onClick={toggleAmbientAudio}
                      className="p-2 border border-white/[0.1] hover:border-white/40 text-zinc-200 transition-colors"
                      title={ambientAudioActive ? "Pause tape" : "Play tape"}
                    >
                      {ambientAudioActive ? (
                        <Pause className="w-3.5 h-3.5" />
                      ) : (
                        <Play className="w-3.5 h-3.5 text-zinc-200" />
                      )}
                    </button>

                    <button
                      onClick={toggleTapeSpeed}
                      className="px-2 py-1.5 border border-white/[0.1] hover:border-white/40 text-[10px] text-zinc-400 hover:text-white uppercase transition-colors"
                    >
                      {tapeWarmth} RPM
                    </button>
                  </div>

                  <div className="flex items-center gap-3">
                    <span className="text-zinc-500 text-[10px]">Tape counter</span>
                    <span className="px-2 py-0.5 bg-black border border-zinc-800 text-zinc-200 text-xs tracking-widest font-mono">
                      00:{tapeCounter < 10 ? `0${tapeCounter}` : tapeCounter}
                    </span>
                  </div>
                </div>

                <div className="w-full mt-2 text-center text-[10px] font-mono text-zinc-600">
                  {ambientAudioActive ? "Spinning spools · Analog tape hiss active" : "Click cassette or scroll to scrub tape motion"}
                </div>
              </div>
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
      {/* 3. KINETIC CONTINUOUS MARQUEE (Kind 50 / Bizarro Style)   */}
      {/* ========================================================= */}
      <section className="relative z-10 border-b border-white/[0.08] bg-black py-4 overflow-hidden select-none">
        <div className="flex w-max animate-[marquee_35s_linear_infinite] hover:[animation-play-state:paused] space-x-12 text-xs font-mono text-zinc-400">
          <span>Multi-tenant isolation</span>
          <span className="text-zinc-600">·</span>
          <span>PostgreSQL row mutex</span>
          <span className="text-zinc-600">·</span>
          <span>Transactional outbox</span>
          <span className="text-zinc-600">·</span>
          <span>Saga backward rollback</span>
          <span className="text-zinc-600">·</span>
          <span>Pinecone vector tombstones</span>
          <span className="text-zinc-600">·</span>
          <span>Resend delivery fabric</span>
          <span className="text-zinc-600">·</span>
          <span>Deterministic DAG state</span>
          <span className="text-zinc-600">·</span>
          <span>Zero orphaned artifacts</span>
          <span className="text-zinc-600">·</span>
          <span>Multi-tenant isolation</span>
          <span className="text-zinc-600">·</span>
          <span>PostgreSQL row mutex</span>
          <span className="text-zinc-600">·</span>
          <span>Transactional outbox</span>
          <span className="text-zinc-600">·</span>
          <span>Saga backward rollback</span>
          <span className="text-zinc-600">·</span>
          <span>Pinecone vector tombstones</span>
        </div>
      </section>

      {/* ========================================================= */}
      {/* 4. PINNED HORIZONTAL CHAPTER RUNWAY (Kind 50 Scroll Experience) */}
      {/* ========================================================= */}
      <section
        ref={chaptersContainerRef}
        className="relative z-20 w-full bg-[#070709] border-b border-white/[0.08] overflow-hidden"
      >
        <div className="pt-16 pb-6 px-6 max-w-7xl mx-auto flex items-center justify-between border-b border-white/[0.06]">
          <div>
            <span className="text-xs font-mono tracking-wider text-zinc-500 block mb-1">
              [ 002 // Kind 50 horizontal runway ]
            </span>
            <h2 className="text-3xl sm:text-5xl font-light tracking-tight text-zinc-100">
              Six architectural chapters
            </h2>
          </div>

          <div className="flex items-center gap-4 font-mono text-xs text-zinc-400">
            <span>Scroll vertically to unfold chapters</span>
            <span className="text-zinc-200 font-bold">
              {Math.round(horizontalProgress * 100)}%
            </span>
          </div>
        </div>

        {/* Horizontal Track Scrub Bar */}
        <div className="w-full bg-zinc-900 h-1 relative">
          <div
            style={{ width: `${Math.max(5, horizontalProgress * 100)}%` }}
            className="h-full bg-zinc-100 shadow-[0_0_12px_rgba(255,255,255,0.4)] transition-all duration-150 ease-out"
          />
        </div>

        {/* Pinned Horizontal Scrolling Track */}
        <div
          ref={chaptersTrackRef}
          className="flex flex-nowrap items-stretch gap-8 px-8 py-16 w-max"
        >
          {CHAPTERS.map((chapter, idx) => {
            const isCurrent = activeChapterIndex === idx;

            return (
              <div
                key={chapter.id}
                className={`w-[85vw] sm:w-[650px] lg:w-[720px] flex-shrink-0 border p-8 sm:p-12 transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] relative flex flex-col justify-between ${
                  isCurrent
                    ? "border-zinc-200 bg-zinc-900/90 shadow-[0_20px_60px_-15px_rgba(255,255,255,0.06)]"
                    : "border-white/[0.08] bg-zinc-950/40 hover:border-zinc-600"
                }`}
              >
                <div>
                  <div className="flex items-center justify-between text-xs font-mono text-zinc-500 mb-6 pb-3 border-b border-white/[0.06]">
                    <span className={isCurrent ? "text-zinc-100 font-bold" : "text-zinc-400"}>
                      CHAPTER [{chapter.index}]
                    </span>
                    <span className="uppercase text-[11px]">{chapter.subtitle}</span>
                  </div>

                  <h3 className="text-3xl sm:text-4xl font-light text-zinc-100 mb-4 leading-tight">
                    {chapter.title}
                  </h3>

                  <blockquote className="font-serif italic text-lg text-zinc-400 mb-6 border-l-2 border-zinc-700 pl-4 py-1">
                    &ldquo;{chapter.quote}&rdquo;
                  </blockquote>

                  <p className="text-sm sm:text-base text-zinc-300 font-light leading-relaxed mb-8">
                    {chapter.detail}
                  </p>

                  <div className="grid grid-cols-3 border border-zinc-800 p-4 text-xs font-mono divide-x divide-zinc-800 bg-black/40 mb-8">
                    {chapter.metrics.map((m) => (
                      <div key={m.label} className="px-3">
                        <span className="text-[10px] text-zinc-500 block mb-0.5">{m.label}</span>
                        <span className="text-zinc-200 font-medium truncate block">{m.value}</span>
                      </div>
                    ))}
                  </div>

                  {/* Verified Source Code in Card */}
                  <pre className="p-4 bg-black border border-zinc-800/80 text-zinc-300 text-xs font-mono overflow-x-auto leading-relaxed">
                    {chapter.code}
                  </pre>
                </div>

                <div className="pt-6 mt-8 border-t border-white/[0.06] flex items-center justify-between">
                  <Link
                    href="/signup"
                    className="text-xs font-mono text-zinc-300 hover:text-white flex items-center gap-1.5 transition-colors group"
                  >
                    <span>Initialize this chapter</span>
                    <ChevronRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-1" />
                  </Link>
                  <span className="text-[10px] font-mono text-zinc-600">
                    KIND 50 // CHAPTER {chapter.index}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* ========================================================= */}
      {/* 5. INTERACTIVE DAG SCHEMATIC WITH SCROLL-DRIVEN TELEMETRY */}
      {/* ========================================================= */}
      <section
        ref={dagSectionRef}
        className="relative z-10 py-24 border-b border-white/[0.08] max-w-7xl mx-auto px-6"
      >
        <div className="flex flex-col sm:flex-row items-start sm:items-end justify-between border-b border-white/[0.08] pb-6 mb-12">
          <div>
            <span className="text-xs font-mono tracking-wider text-zinc-500 block mb-1">
              [ 003 // Schematic ]
            </span>
            <h2 className="text-3xl sm:text-4xl font-light tracking-tight text-zinc-100">
              Reactive DAG pipeline inspection
            </h2>
          </div>
          <span className="text-xs font-mono text-zinc-400 mt-2 sm:mt-0">
            Scroll or click to advance through execution nodes
          </span>
        </div>

        <div className="relative border border-white/[0.08] bg-zinc-950/60 p-6 sm:p-10">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 relative z-10">
            {DAG_NODES.map((node, idx) => {
              const isSelected = selectedDagIndex === idx;

              return (
                <div
                  key={node.id}
                  onClick={() => setSelectedDagIndex(idx)}
                  className={`cursor-pointer p-6 border transition-all duration-400 ease-[cubic-bezier(0.16,1,0.3,1)] relative hover:-translate-y-1 ${
                    isSelected
                      ? "border-zinc-200 bg-zinc-900/95 shadow-[0_12px_35px_rgba(255,255,255,0.08)]"
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

          <div className="mt-8 border border-white/[0.08] bg-black p-6 font-mono text-xs transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]">
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
        </div>
      </section>

      {/* ========================================================= */}
      {/* 6. EDITORIAL MANIFESTO: The Late-Night Creed              */}
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
      {/* 7. FOOTER: Minimalist Architectural Colophon             */}
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

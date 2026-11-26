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
  ChevronLeft,
  Move,
  Copy,
  Check,
} from "lucide-react";

// ============================================================================
// ARCHITECTURAL DATA CONTRACTS
// ============================================================================

interface OrbitalCard {
  id: string;
  index: string;
  tag: string;
  title: string;
  subtitle: string;
  metric: string;
  codeSnippet: string;
}

const ORBITAL_CARDS: OrbitalCard[] = [
  {
    id: "mutex",
    index: "01",
    tag: "Row lock serialization",
    title: "PostgreSQL row mutex",
    subtitle: "FOR UPDATE concurrency gate",
    metric: "Sole admin invariant",
    codeSnippet: `SELECT id FROM "Organization" WHERE id = $orgId FOR UPDATE;`,
  },
  {
    id: "outbox",
    index: "02",
    tag: "Domain CDC persistence",
    title: "Transactional outbox",
    subtitle: "Atomic domain event creation",
    metric: "0 ghost event leaks",
    codeSnippet: `await db.$transaction([tx.task.update(...), tx.outbox.create(...)]);`,
  },
  {
    id: "saga",
    index: "03",
    tag: "Deterministic DAG",
    title: "Reverse saga engine",
    subtitle: "Backward compensation chain",
    metric: "Zero orphaned state",
    codeSnippet: `await saga.compensate({ runId, chain: step.compensatingActions });`,
  },
  {
    id: "agent",
    index: "04",
    tag: "Human approval boundary",
    title: "Midnight agent gate",
    subtitle: "Reviewable diff signature",
    metric: "Dual-key verification",
    codeSnippet: `if (proposal.criticality === "HIGH") renderApprovalCard(proposal);`,
  },
  {
    id: "tombstone",
    index: "05",
    tag: "Vector lifecycle",
    title: "Pinecone tombstones",
    subtitle: "Deterministic vector erasure",
    metric: "Strict tenant isolation",
    codeSnippet: `await pinecone.deleteMany({ filter: { orgId: { $eq: orgId } } });`,
  },
  {
    id: "tokens",
    index: "06",
    tag: "Cryptographic delivery",
    title: "Resend token fabric",
    subtitle: "24-hour single-tenant invite",
    metric: "Crypto-random UUID",
    codeSnippet: `await db.invitation.create({ token: crypto.randomUUID(), orgId });`,
  },
];

interface SystemChapter {
  id: string;
  index: string;
  title: string;
  subtitle: string;
  detail: string;
  quote: string;
  fileName: string;
  metrics: { label: string; value: string }[];
  code: string;
}

const CHAPTERS: SystemChapter[] = [
  {
    id: "identity",
    index: "01",
    title: "Tenant sanctuary & row mutex",
    subtitle: "PostgreSQL row lock serialization",
    detail: "Complete account onboarding, active organization context switching, and strict last-administrator safeguards enforced via database row-level mutex transactions.",
    quote: "A team should never be left without an anchor. Row locks guarantee exactly one admin always remains.",
    fileName: "mutex.transaction.ts",
    metrics: [
      { label: "Primitive", value: "SELECT FOR UPDATE" },
      { label: "Isolation", value: "Read committed" },
      { label: "Guarantee", value: "Sole admin invariant" },
    ],
    code: `await db.$transaction(async (tx) => {
  // Acquire row-level mutex on the organization anchor
  await tx.$executeRaw\`SELECT id FROM "Organization" WHERE id = \${orgId} FOR UPDATE\`;
  
  const admins = await tx.membership.count({
    where: { organizationId: orgId, role: "ADMIN" }
  });
  if (admins <= 1) {
    throw new Error("LAST_ADMIN_PROTECTED");
  }
  return tx.membership.delete({ where: { id: targetId } });
});`,
  },
  {
    id: "outbox",
    index: "02",
    title: "Transactional event outbox",
    subtitle: "Atomic domain CDC persistence",
    detail: "Domain events are written to PostgreSQL inside the same atomic transaction as the mutation. Distributed Redis leases prevent split-brain workers.",
    quote: "No ghost events. If the database rolls back, the event was never born.",
    fileName: "cdc.outbox.ts",
    metrics: [
      { label: "Outbox pattern", value: "Dual-write elimination" },
      { label: "Delivery", value: "At-least-once" },
      { label: "Lock mechanism", value: "Redis lease mutex" },
    ],
    code: `await db.$transaction([
  db.task.update({
    where: { id: taskId },
    data: { status: "IN_PROGRESS" }
  }),
  db.outboxEvent.create({
    data: {
      type: "task.updated",
      payload: { taskId, orgId, timestamp: Date.now() }
    }
  })
]);`,
  },
  {
    id: "saga",
    index: "03",
    title: "Deterministic saga engine",
    subtitle: "Reverse rollback compensation",
    detail: "Workflows execute as deterministic directed acyclic graphs. When an external step times out or fails, registered backward compensation routines trigger in reverse order.",
    quote: "When distributed steps break in the night, the engine walks back its footprints clean.",
    fileName: "saga.engine.ts",
    metrics: [
      { label: "Topology", value: "Deterministic DAG" },
      { label: "Rollback", value: "Reverse saga chain" },
      { label: "Side effects", value: "Zero orphaned state" },
    ],
    code: `try {
  await executeStep(step, context);
} catch (error) {
  // Trigger backward compensation chain in reverse order
  await sagaEngine.compensate({
    runId,
    failedStepId: step.id,
    compensationChain: step.compensatingActions.reverse()
  });
  throw new SagaCompensatedError(runId, step.id);
}`,
  },
  {
    id: "agent",
    index: "04",
    title: "Midnight autonomous agent",
    subtitle: "Inline human approval boundary",
    detail: "A conversational assistant that reasons over organization context and proposes structural DAG adjustments. High-impact operations present reviewable diff cards for human sign-off.",
    quote: "Intelligence that asks before it cuts. Critical migrations require human touch.",
    fileName: "agent.proposal.ts",
    metrics: [
      { label: "Execution model", value: "Tool proposal gateway" },
      { label: "Safety tier", value: "Human-in-the-loop" },
      { label: "Memory", value: "Scoped vector sandbox" },
    ],
    code: `const proposal = await agent.planModification({
  prompt,
  currentWorkflow
});

if (proposal.criticality === "HIGH") {
  return renderApprovalCard({
    proposal,
    requiresSignature: true,
    expiresAt: Date.now() + 3600000
  });
}`,
  },
  {
    id: "notifications",
    index: "05",
    title: "Whispered notification fabric",
    subtitle: "Cryptographic 24-hour tokens",
    detail: "Team member invitation lifecycles, transactional alerts, and delivery feedback backed by Resend API infrastructure with recipient boundary verification.",
    quote: "Invitations that respect borders. Tokens expire like milk at dawn.",
    fileName: "resend.delivery.ts",
    metrics: [
      { label: "Token entropy", value: "crypto.randomUUID()" },
      { label: "TTL lifespan", value: "24-hour auto-expire" },
      { label: "Scope", value: "Single-tenant boundary" },
    ],
    code: `const token = crypto.randomUUID();
await db.invitation.create({
  data: {
    email,
    token,
    expiresAt: new Date(Date.now() + 86400000),
    organizationId
  }
});`,
  },
  {
    id: "vectors",
    index: "06",
    title: "Semantic vector lifecycle",
    subtitle: "Pinecone indexing & deterministic tombstones",
    detail: "Project attachments upload to UploadThing, parse into semantic markdown chunks, generate embeddings, and ensure clean vector tombstoning on document deletion.",
    quote: "A system that forgets on command. Deleting a document wipes its ghost from vector space.",
    fileName: "pinecone.tombstone.ts",
    metrics: [
      { label: "Search index", value: "Cosine hybrid vector" },
      { label: "Chunking", value: "Semantic boundary" },
      { label: "Tombstoning", value: "Synchronous delete" },
    ],
    code: `await pinecone.index.deleteMany({
  filter: {
    organizationId: { $eq: orgId },
    documentId: { $eq: fileId }
  }
});`,
  },
];

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

// ============================================================================
// AUDIO GENERATORS (ANALOG TAPE HISS & MECHANICAL CLICKS)
// ============================================================================

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

    if (Math.random() < 0.0006) {
      pink += (Math.random() - 0.5) * 4.2;
    }

    output[i] = pink * 0.04;
  }

  return noiseBuffer;
}

function playMechanicalClick(ctx: AudioContext | null) {
  if (!ctx || ctx.state !== "running") return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(460, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(90, ctx.currentTime + 0.04);
    gain.gain.setValueAtTime(0.09, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.04);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.045);
  } catch {
    // ignore
  }
}

// ============================================================================
// 3D CASSETTE PHYSICS OBJECT DEFINITION (PHOTOREALISTIC ACTIVE-THEORY STYLE)
// ============================================================================

interface PhysicsBody {
  id: string;
  name: string;
  tapeType: string;
  timeTag: string;
  serial: string;
  side: "A" | "B";
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  rotX: number;
  rotY: number;
  rotZ: number;
  vRotX: number;
  vRotY: number;
  vRotZ: number;
  width: number;
  height: number;
  isDragging: boolean;
  accent: string;
}

export default function Home() {
  const [ambientAudioActive, setAmbientAudioActive] = useState(false);
  const [tapeWarmth, setTapeWarmth] = useState<"33" | "45">("33");
  const [selectedDagIndex, setSelectedDagIndex] = useState(0);
  const [activeChapterIndex, setActiveChapterIndex] = useState(0);
  const [currentTimeUTC, setCurrentTimeUTC] = useState<string>("");
  const [tapeCounter, setTapeCounter] = useState(14);
  const [copiedCode, setCopiedCode] = useState(false);
  const [activeHoverOrbitalIndex, setActiveHoverOrbitalIndex] = useState<number | null>(null);

  // --- KIND 50 ORBITAL WHEEL STATE ---
  const [wheelAngle, setWheelAngle] = useState(0);
  const [isDraggingWheel, setIsDraggingWheel] = useState(false);
  const isDraggingWheelRef = useRef(false);
  const wheelStartPointerX = useRef(0);
  const wheelAngleRef = useRef(0);
  const wheelVelocityRef = useRef(0.002);
  const lastWheelPointerX = useRef(0);
  const lastWheelTimestamp = useRef(0);

  // --- BIZARRO 3D PHYSICS CANVAS REFS ---
  const physicsCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const bodiesRef = useRef<PhysicsBody[]>([
    {
      id: "tape-1",
      name: "FORGE UX-PRO 90",
      tapeType: "SUPER CHROME CLASS · BIAS 70µs",
      timeTag: "POSTGRES MUTEX MASTER",
      serial: "CR-90-A882",
      side: "A",
      x: -160,
      y: -25,
      z: 0,
      vx: 0.35,
      vy: 0.15,
      vz: 0,
      rotX: 8,
      rotY: -12,
      rotZ: -6,
      vRotX: 0.06,
      vRotY: 0.08,
      vRotZ: 0.03,
      width: 290,
      height: 180,
      isDragging: false,
      accent: "#f4f4f5",
    },
    {
      id: "tape-2",
      name: "TRANSACTION OUTBOX",
      tapeType: "ATOMIC CDC LOG · 50ms LEASE",
      timeTag: "DISTRIBUTED REDIS GATE",
      serial: "TX-50-K104",
      side: "B",
      x: 150,
      y: 40,
      z: -30,
      vx: -0.25,
      vy: 0.3,
      vz: 0,
      rotX: -7,
      rotY: 14,
      rotZ: 10,
      vRotX: -0.05,
      vRotY: -0.07,
      vRotZ: 0.02,
      width: 280,
      height: 175,
      isDragging: false,
      accent: "#e4e4e7",
    },
    {
      id: "tape-3",
      name: "SAGA ROLLBACK FLIGHT",
      tapeType: "REVERSE DAG RECORDER · 24-HR",
      timeTag: "PINECONE TOMBSTONES",
      serial: "SG-04-R991",
      side: "A",
      x: 10,
      y: -120,
      z: 15,
      vx: 0.18,
      vy: -0.22,
      vz: 0,
      rotX: 12,
      rotY: 8,
      rotZ: -12,
      vRotX: 0.04,
      vRotY: 0.05,
      vRotZ: -0.04,
      width: 285,
      height: 178,
      isDragging: false,
      accent: "#d4d4d8",
    },
  ]);
  const activeDraggedBodyRef = useRef<PhysicsBody | null>(null);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const lastMousePosRef = useRef({ x: 0, y: 0, time: 0 });
  const spoolRotationRef = useRef(0);

  // Smooth lerped mouse coordinates for ambient spotlight
  const targetMousePos = useRef({ x: 0, y: 0 });
  const [smoothMousePos, setSmoothMousePos] = useState({ x: 0, y: 0 });

  // Web Audio & Spectrum Visualizer Refs
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const spectrumAnimIdRef = useRef<number | null>(null);
  const filterNodeRef = useRef<BiquadFilterNode | null>(null);
  const decayingBarsRef = useRef<number[]>(new Array(18).fill(2));

  // Section Refs
  const heroRef = useRef<HTMLElement | null>(null);
  const scrambleTriggerRef = useRef(0);

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

  // Smooth mouse lerp loop
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

  const handleMouseMoveGlobal = (e: React.MouseEvent<HTMLDivElement>) => {
    targetMousePos.current = { x: e.clientX, y: e.clientY };
  };

  // ==========================================================================
  // KIND 50: 3D ORBITAL CAROUSEL WHEEL PHYSICS & DRAG LOOP
  // ==========================================================================
  useEffect(() => {
    let animId: number;

    const updateOrbitalWheel = () => {
      if (!isDraggingWheelRef.current) {
        if (Math.abs(wheelVelocityRef.current) > 0.0008) {
          wheelVelocityRef.current *= 0.94;
        } else {
          wheelVelocityRef.current = activeHoverOrbitalIndex !== null ? 0 : 0.0016;
        }
        wheelAngleRef.current += wheelVelocityRef.current;
        setWheelAngle(wheelAngleRef.current);
      }
      animId = requestAnimationFrame(updateOrbitalWheel);
    };

    animId = requestAnimationFrame(updateOrbitalWheel);
    return () => cancelAnimationFrame(animId);
  }, [activeHoverOrbitalIndex]);

  const handleWheelPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    isDraggingWheelRef.current = true;
    setIsDraggingWheel(true);
    wheelStartPointerX.current = e.clientX;
    lastWheelPointerX.current = e.clientX;
    lastWheelTimestamp.current = performance.now();
    wheelVelocityRef.current = 0;
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };

  const handleWheelPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingWheelRef.current) return;
    const now = performance.now();
    const dt = Math.max(1, now - lastWheelTimestamp.current);
    const dx = e.clientX - lastWheelPointerX.current;

    const dTheta = (dx / 460) * 1.4;
    wheelAngleRef.current += dTheta;
    setWheelAngle(wheelAngleRef.current);

    wheelVelocityRef.current = dTheta / (dt / 16.6);
    lastWheelPointerX.current = e.clientX;
    lastWheelTimestamp.current = now;
  };

  const handleWheelPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingWheelRef.current) return;
    isDraggingWheelRef.current = false;
    setIsDraggingWheel(false);
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    playMechanicalClick(audioCtxRef.current);
  };

  // ==========================================================================
  // BIZARRO: PHOTOREALISTIC 3D CASSETTE PHYSICS SIMULATION CANVAS
  // ==========================================================================
  useEffect(() => {
    const canvas = physicsCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let animId: number;

    const renderPhysics = () => {
      animId = requestAnimationFrame(renderPhysics);

      const width = canvas.width;
      const height = canvas.height;
      const cx = width / 2;
      const cy = height / 2;

      ctx.clearRect(0, 0, width, height);

      // Advance tape spools
      spoolRotationRef.current += ambientAudioActive ? 0.05 : 0.01;

      const bodies = bodiesRef.current;

      // Apply any queued scramble impulse
      if (scrambleTriggerRef.current > 0) {
        scrambleTriggerRef.current = 0;
        for (const b of bodies) {
          b.vx = (Math.random() - 0.5) * 16;
          b.vy = (Math.random() - 0.5) * 16;
          b.vRotZ = (Math.random() - 0.5) * 2.8;
        }
      }

      // Update positions and velocities
      for (const b of bodies) {
        if (!b.isDragging) {
          b.x += b.vx;
          b.y += b.vy;
          b.rotX += b.vRotX;
          b.rotY += b.vRotY;
          b.rotZ += b.vRotZ;

          // Gentle ambient damping
          b.vx *= 0.992;
          b.vy *= 0.992;
          b.vRotX *= 0.995;
          b.vRotY *= 0.995;
          b.vRotZ *= 0.995;

          // Boundary bouncing
          const boundX = width / 2 - 150;
          const boundY = height / 2 - 100;

          if (b.x < -boundX) {
            b.x = -boundX;
            b.vx = Math.abs(b.vx) * 0.72 + 0.1;
            b.vRotZ += 0.2;
            playMechanicalClick(audioCtxRef.current);
          } else if (b.x > boundX) {
            b.x = boundX;
            b.vx = -Math.abs(b.vx) * 0.72 - 0.1;
            b.vRotZ -= 0.2;
            playMechanicalClick(audioCtxRef.current);
          }

          if (b.y < -boundY) {
            b.y = -boundY;
            b.vy = Math.abs(b.vy) * 0.72 + 0.1;
            b.vRotX += 0.2;
            playMechanicalClick(audioCtxRef.current);
          } else if (b.y > boundY) {
            b.y = boundY;
            b.vy = -Math.abs(b.vy) * 0.72 - 0.1;
            b.vRotX -= 0.2;
            playMechanicalClick(audioCtxRef.current);
          }
        }
      }

      // Sort by Z for realistic depth layering
      const sortedBodies = [...bodies].sort((a, b) => a.z - b.z);

      for (const b of sortedBodies) {
        ctx.save();
        ctx.translate(cx + b.x, cy + b.y);

        // Apply 3D perspective projection
        const radZ = (b.rotZ * Math.PI) / 180;
        const radY = (b.rotY * Math.PI) / 180;
        const radX = (b.rotX * Math.PI) / 180;

        ctx.rotate(radZ);
        ctx.scale(Math.cos(radY), Math.cos(radX));

        const w = b.width;
        const h = b.height;

        // Realistic layered contact shadow
        ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
        ctx.shadowBlur = b.isDragging ? 36 : 22;
        ctx.shadowOffsetX = 10;
        ctx.shadowOffsetY = 18;

        // 1. MAIN CASSETTE SHELL (Rounded Beveled Body)
        const cornerR = 7;
        ctx.beginPath();
        ctx.roundRect(-w / 2, -h / 2, w, h, cornerR);

        // Deep obsidian plastic gradient
        const bodyGrad = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
        bodyGrad.addColorStop(0, "#1c1c24");
        bodyGrad.addColorStop(0.5, "#121218");
        bodyGrad.addColorStop(1, "#0a0a0f");
        ctx.fillStyle = bodyGrad;
        ctx.fill();

        // 3D Bevel Edge Highlights
        ctx.strokeStyle = b.isDragging ? "#ffffff" : "rgba(255, 255, 255, 0.22)";
        ctx.lineWidth = b.isDragging ? 2 : 1;
        ctx.stroke();

        ctx.shadowColor = "transparent";

        // Inner Chamfer Line
        ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(-w / 2 + 5, -h / 2 + 5, w - 10, h - 10, 4);
        ctx.stroke();

        // 2. BOTTOM TRAPEZOID HEAD NOTCH (Signature Cassette Geometry)
        ctx.fillStyle = "#0c0c10";
        ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
        ctx.beginPath();
        ctx.moveTo(-w / 3.2, h / 2 - 2);
        ctx.lineTo(-w / 4, h / 2 - 22);
        ctx.lineTo(w / 4, h / 2 - 22);
        ctx.lineTo(w / 3.2, h / 2 - 2);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Exposed Magnetic Tape Ribbon across the notch
        ctx.strokeStyle = "#382318";
        ctx.lineWidth = 9;
        ctx.beginPath();
        ctx.moveTo(-w / 4 + 6, h / 2 - 11);
        ctx.lineTo(w / 4 - 6, h / 2 - 11);
        ctx.stroke();

        // Dual brass roller pins in the notch
        const drawRoller = (rollerX: number) => {
          ctx.fillStyle = "#8a7556";
          ctx.beginPath();
          ctx.arc(rollerX, h / 2 - 11, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.fillStyle = "#ded6c5";
          ctx.beginPath();
          ctx.arc(rollerX, h / 2 - 11, 1.5, 0, Math.PI * 2);
          ctx.fill();
        };
        drawRoller(-w / 4 + 14);
        drawRoller(w / 4 - 14);

        // 3. VINTAGE SILVER FOIL LABEL PLATE
        const labelW = w - 24;
        const labelH = 62;
        const labelY = -h / 2 + 12;

        const labelGrad = ctx.createLinearGradient(-labelW / 2, labelY, labelW / 2, labelY + labelH);
        labelGrad.addColorStop(0, "#22222d");
        labelGrad.addColorStop(0.5, "#181822");
        labelGrad.addColorStop(1, "#14141c");
        ctx.fillStyle = labelGrad;
        ctx.beginPath();
        ctx.roundRect(-labelW / 2, labelY, labelW, labelH, 3);
        ctx.fill();
        ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
        ctx.stroke();

        // Silver Accent Stripe on label
        ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
        ctx.fillRect(-labelW / 2, labelY + 38, labelW, 2);

        // Technical Typography on Label
        ctx.fillStyle = b.accent;
        ctx.font = "bold 11px monospace";
        ctx.fillText(b.name, -labelW / 2 + 12, labelY + 20);

        ctx.fillStyle = "#a1a1aa";
        ctx.font = "9px monospace";
        ctx.fillText(b.tapeType, -labelW / 2 + 12, labelY + 34);

        // Side badge (A or B)
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 13px monospace";
        ctx.fillText(b.side, labelW / 2 - 20, labelY + 22);
        ctx.fillStyle = "#71717a";
        ctx.font = "8px monospace";
        ctx.fillText(b.serial, labelW / 2 - 68, labelY + 34);

        // 4. RECESSED ACRYLIC CENTER VIEWING WINDOW
        const winW = w * 0.54;
        const winH = 46;
        const winY = -6;

        ctx.fillStyle = "rgba(4, 4, 6, 0.9)";
        ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(-winW / 2, winY, winW, winH, 4);
        ctx.fill();
        ctx.stroke();

        // Diagonal Glass Glare Reflection
        const glassGrad = ctx.createLinearGradient(-winW / 2, winY, winW / 2, winY + winH);
        glassGrad.addColorStop(0, "rgba(255, 255, 255, 0.12)");
        glassGrad.addColorStop(0.4, "rgba(255, 255, 255, 0.03)");
        glassGrad.addColorStop(0.6, "transparent");
        ctx.fillStyle = glassGrad;
        ctx.beginPath();
        ctx.roundRect(-winW / 2, winY, winW, winH, 4);
        ctx.fill();

        // Tape Meter Scale Markings
        ctx.fillStyle = "rgba(255, 255, 255, 0.25)";
        ctx.font = "7px monospace";
        ctx.fillText("100  ·  50  ·  0", -28, winY + 26);

        // 5. AUTHENTIC TAPE SPOOLS WITH 6-TOOTH SPROCKETS
        const drawSpool = (spoolX: number, tapeRadius: number, angle: number) => {
          ctx.save();
          ctx.translate(spoolX, winY + winH / 2);

          // Wound magnetic tape pack (dark brown layered circle)
          const tapeGrad = ctx.createRadialGradient(0, 0, 12, 0, 0, tapeRadius);
          tapeGrad.addColorStop(0, "#24160f");
          tapeGrad.addColorStop(1, "#3d271b");
          ctx.fillStyle = tapeGrad;
          ctx.beginPath();
          ctx.arc(0, 0, tapeRadius, 0, Math.PI * 2);
          ctx.fill();

          // Concentric tape layer lines
          ctx.strokeStyle = "rgba(0, 0, 0, 0.4)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(0, 0, tapeRadius * 0.75, 0, Math.PI * 2);
          ctx.stroke();

          // White inner drive reel ring
          ctx.fillStyle = "#ededf0";
          ctx.beginPath();
          ctx.arc(0, 0, 13, 0, Math.PI * 2);
          ctx.fill();

          // 6 Rotating sprocket teeth
          ctx.rotate(angle);
          ctx.strokeStyle = "#08080c";
          ctx.lineWidth = 2.2;
          for (let i = 0; i < 6; i++) {
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.lineTo(0, -11);
            ctx.stroke();
            ctx.rotate((Math.PI * 2) / 6);
          }

          // Center Red Hub Core
          ctx.fillStyle = "#8b1c1c";
          ctx.beginPath();
          ctx.arc(0, 0, 4.5, 0, Math.PI * 2);
          ctx.fill();

          ctx.restore();
        };

        // Left spool has more tape, right spool has less
        drawSpool(-winW / 3.4, 23, spoolRotationRef.current);
        drawSpool(winW / 3.4, 16, spoolRotationRef.current * 0.94);

        // 6. CORNER METALLIC PHILIPS SCREWS
        const drawScrew = (sx: number, sy: number, slotAngle: number) => {
          ctx.save();
          ctx.translate(sx, sy);
          ctx.fillStyle = "#3a3a46";
          ctx.beginPath();
          ctx.arc(0, 0, 3.5, 0, Math.PI * 2);
          ctx.fill();
          ctx.strokeStyle = "rgba(255, 255, 255, 0.25)";
          ctx.lineWidth = 0.8;
          ctx.stroke();

          // Cross slot
          ctx.rotate(slotAngle);
          ctx.strokeStyle = "#121218";
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(-2, 0);
          ctx.lineTo(2, 0);
          ctx.moveTo(0, -2);
          ctx.lineTo(0, 2);
          ctx.stroke();
          ctx.restore();
        };

        drawScrew(-w / 2 + 10, -h / 2 + 10, 0.4);
        drawScrew(w / 2 - 10, -h / 2 + 10, 1.2);
        drawScrew(-w / 2 + 10, h / 2 - 10, 0.8);
        drawScrew(w / 2 - 10, h / 2 - 10, 1.9);
        drawScrew(0, -h / 2 + 8, 0.1);

        // 7. BIZARRO TECHNICAL HUD TARGETING OVERLAY
        if (b.isDragging) {
          ctx.strokeStyle = "rgba(255, 255, 255, 0.5)";
          ctx.lineWidth = 1;
          ctx.setLineDash([4, 4]);

          ctx.beginPath();
          ctx.moveTo(-w / 2 - 24, 0);
          ctx.lineTo(-w / 2 - 8, 0);
          ctx.moveTo(w / 2 + 8, 0);
          ctx.lineTo(w / 2 + 24, 0);
          ctx.moveTo(0, -h / 2 - 24);
          ctx.lineTo(0, -h / 2 - 8);
          ctx.moveTo(0, h / 2 + 8);
          ctx.lineTo(0, h / 2 + 24);
          ctx.stroke();
          ctx.setLineDash([]);

          ctx.fillStyle = "#ffffff";
          ctx.font = "9px monospace";
          ctx.fillText(`pos: [${Math.round(b.x)}, ${Math.round(b.y)}]`, w / 2 + 12, -h / 2 + 12);
          ctx.fillStyle = "#a1a1aa";
          ctx.fillText(`rotZ: ${Math.round(b.rotZ)}°  v: ${(Math.hypot(b.vx, b.vy) * 10).toFixed(1)} px/s`, w / 2 + 12, -h / 2 + 26);
        }

        ctx.restore();
      }
    };

    animId = requestAnimationFrame(renderPhysics);

    return () => cancelAnimationFrame(animId);
  }, [ambientAudioActive]);

  // Pointer interactions for the Bizarro Physics Canvas
  const handlePhysicsPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = physicsCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - canvas.width / 2;
    const mouseY = e.clientY - rect.top - canvas.height / 2;

    const bodies = bodiesRef.current;
    for (let i = bodies.length - 1; i >= 0; i--) {
      const b = bodies[i];
      if (
        mouseX >= b.x - b.width / 2 &&
        mouseX <= b.x + b.width / 2 &&
        mouseY >= b.y - b.height / 2 &&
        mouseY <= b.y + b.height / 2
      ) {
        b.isDragging = true;
        activeDraggedBodyRef.current = b;
        dragOffsetRef.current = { x: mouseX - b.x, y: mouseY - b.y };
        lastMousePosRef.current = { x: mouseX, y: mouseY, time: performance.now() };

        bodies.splice(i, 1);
        bodies.push(b);

        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        playMechanicalClick(audioCtxRef.current);
        break;
      }
    }
  };

  const handlePhysicsPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const b = activeDraggedBodyRef.current;
    if (!b) return;

    const canvas = physicsCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left - canvas.width / 2;
    const mouseY = e.clientY - rect.top - canvas.height / 2;

    const now = performance.now();
    const dt = Math.max(1, now - lastMousePosRef.current.time);

    b.vx = ((mouseX - lastMousePosRef.current.x) / dt) * 15;
    b.vy = ((mouseY - lastMousePosRef.current.y) / dt) * 15;
    b.vRotZ = b.vx * 0.08;

    b.x = mouseX - dragOffsetRef.current.x;
    b.y = mouseY - dragOffsetRef.current.y;

    lastMousePosRef.current = { x: mouseX, y: mouseY, time: now };
  };

  const handlePhysicsPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const b = activeDraggedBodyRef.current;
    if (b) {
      b.isDragging = false;
      activeDraggedBodyRef.current = null;
      (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
      playMechanicalClick(audioCtxRef.current);
    }
  };

  const handleScrambleCassettes = () => {
    scrambleTriggerRef.current += 1;
    playMechanicalClick(audioCtxRef.current);
  };

  // ==========================================================================
  // WEB AUDIO & SPECTRUM VISUALIZER
  // ==========================================================================
  const renderSpectrum = useCallback(() => {
    if (!canvasRef.current || !analyserRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const analyser = analyserRef.current;
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      spectrumAnimIdRef.current = requestAnimationFrame(draw);
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
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;

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
    playMechanicalClick(audioCtxRef.current);
  };

  const handleCopyCode = (code: string) => {
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      navigator.clipboard.writeText(code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
      playMechanicalClick(audioCtxRef.current);
    }
  };

  const handleSelectChapter = (idx: number) => {
    setActiveChapterIndex(idx);
    playMechanicalClick(audioCtxRef.current);
  };

  useEffect(() => {
    return () => {
      if (spectrumAnimIdRef.current) {
        cancelAnimationFrame(spectrumAnimIdRef.current);
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
      onMouseMove={handleMouseMoveGlobal}
      className="relative min-h-screen bg-[#060608] text-zinc-100 font-sans antialiased selection:bg-zinc-800 selection:text-white overflow-x-hidden"
    >
      {/* Dynamic Ambient Mouse Spotlight */}
      <div
        className="pointer-events-none fixed inset-0 z-0 transition-opacity duration-700 ease-out opacity-60"
        style={{
          background: `radial-gradient(850px circle at ${smoothMousePos.x}px ${smoothMousePos.y}px, rgba(255, 255, 255, 0.045), transparent 80%)`,
        }}
      />

      {/* Parallax Blueprint Grid */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.03] bg-[linear-gradient(to_right,#ffffff_1px,transparent_1px),linear-gradient(to_bottom,#ffffff_1px,transparent_1px)] bg-[size:48px_48px]"
      />

      {/* Subtle 35mm Analog Film Grain Texture */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-40 opacity-[0.035] mix-blend-screen bg-repeat"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E")`,
        }}
      />

      {/* ===================================================================== */}
      {/* 1. TOP NAV: Museum-Grade Hairline Navigation                          */}
      {/* ===================================================================== */}
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-white/[0.08] bg-[#060608]/85 backdrop-blur-xl transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)]">
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

          {/* Sound Deck Controls */}
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

      {/* ===================================================================== */}
      {/* 2. HERO: KIND 50 3D ORBITAL ROTATING WHEEL & MONUMENTAL TYPOGRAPHY    */}
      {/* ===================================================================== */}
      <section
        ref={heroRef}
        className="relative z-10 min-h-[96vh] flex flex-col items-center justify-center pt-24 pb-20 border-b border-white/[0.08]"
      >
        {/* Monumental Backdrop Typography Spanning Full Edge-to-Edge (Kind 50 Style) */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 flex items-center justify-center select-none opacity-[0.065] overflow-hidden whitespace-nowrap"
        >
          <span className="font-sans font-black tracking-[-0.05em] text-[18vw] leading-none uppercase text-white">
            ORCHESTRATION
          </span>
        </div>

        {/* Center Stage: The 3D Orbital Interactive Carousel Stage */}
        <div
          onPointerDown={handleWheelPointerDown}
          onPointerMove={handleWheelPointerMove}
          onPointerUp={handleWheelPointerUp}
          className="relative w-full max-w-6xl h-[720px] flex items-center justify-center cursor-grab active:cursor-grabbing select-none"
          title="Click and drag horizontally to spin the system orbital wheel"
        >
          {/* Circular Orbital Ring of System Invariant Cards (Kind 50 Architecture) */}
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            {ORBITAL_CARDS.map((card, idx) => {
              const total = ORBITAL_CARDS.length;
              const angle = wheelAngle + (idx / total) * (Math.PI * 2);
              const radiusX = 480; // Expanded horizontal radius for clean separation
              const radiusY = 265; // Ample vertical clearance below center console

              const posX = Math.cos(angle) * radiusX;
              const posY = Math.sin(angle) * radiusY;

              // 3D Depth Scale & Perspective
              const depthFactor = (Math.sin(angle) + 1) / 2; // 0 (far) to 1 (near)
              const scale = 0.82 + depthFactor * 0.32;
              const opacity = 0.65 + depthFactor * 0.35;
              const zIndex = Math.round(depthFactor * 30);
              const isHovered = activeHoverOrbitalIndex === idx;

              return (
                <div
                  key={card.id}
                  onPointerEnter={() => setActiveHoverOrbitalIndex(idx)}
                  onPointerLeave={() => setActiveHoverOrbitalIndex(null)}
                  style={{
                    transform: `translate3d(${posX}px, ${posY}px, 0) scale(${isHovered ? scale * 1.08 : scale}) rotate(${posX * 0.008}deg)`,
                    opacity,
                    zIndex: isHovered ? 50 : zIndex,
                    transition: isDraggingWheel ? "none" : "transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.25s ease",
                  }}
                  className={`pointer-events-auto absolute w-60 sm:w-64 p-4 border bg-gradient-to-b from-[#1c1c2b]/95 to-[#101018]/95 backdrop-blur-md shadow-[0_22px_50px_rgba(0,0,0,0.92)] transition-all duration-300 ${
                    isHovered
                      ? "border-white text-white shadow-[0_22px_55px_rgba(255,255,255,0.22),inset_0_1px_0_rgba(255,255,255,0.4)]"
                      : "border-white/[0.24] text-zinc-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.2)]"
                  }`}
                >
                  <div className="flex items-center justify-between text-[10px] font-mono text-zinc-400 pb-2 border-b border-white/[0.1] mb-2.5">
                    <span className="text-zinc-100 font-bold">[ {card.index} ]</span>
                    <span className="text-zinc-300 font-medium">{card.tag}</span>
                  </div>

                  <h3 className="font-mono text-xs font-semibold text-zinc-100 tracking-tight leading-snug">
                    {card.title}
                  </h3>
                  <p className="text-[11px] text-zinc-400 mt-1 font-light leading-snug">
                    {card.subtitle}
                  </p>

                  <div className="mt-3 pt-2.5 border-t border-white/[0.08] flex items-center justify-between text-[10px] font-mono text-zinc-400">
                    <span className="text-zinc-200 font-medium">{card.metric}</span>
                    <ChevronRight className="w-3 h-3 text-zinc-400" />
                  </div>
                </div>
              );
            })}
          </div>

          {/* Center Monumental Console (Framed by the Orbital Wheel) */}
          <div className="relative z-40 max-w-lg text-center px-6 pointer-events-auto">
            <div className="inline-flex items-center gap-2.5 border border-white/[0.14] bg-zinc-950/90 px-3.5 py-1.5 text-[11px] font-mono text-zinc-300 mb-6 shadow-xl backdrop-blur-md">
              <span className="text-zinc-100 font-semibold">[ System 01 ]</span>
              <span>·</span>
              <span>Multi-tenant architecture</span>
              <span>·</span>
              <span className="text-zinc-400 flex items-center gap-1">
                <Move className="w-3 h-3 text-zinc-400" />
                <span>Drag to spin</span>
              </span>
            </div>

            <h1 className="text-4xl sm:text-6xl font-light tracking-[-0.03em] leading-[0.98] text-zinc-100">
              Orchestration <br />
              <span className="font-serif italic font-normal tracking-tight text-zinc-400 text-3xl sm:text-5xl block mt-2">
                in slow motion.
              </span>
            </h1>

            <p className="text-sm sm:text-base text-zinc-400 font-light leading-relaxed mt-5 max-w-md mx-auto">
              A multi-tenant, event-driven engine where workflows, teams, and autonomous agents operate with quiet, deterministic certainty.
            </p>

            {/* Tactical Interactive Action CTAs */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mt-7">
              <Link
                href="/signup"
                className="w-full sm:w-auto py-3 px-6 bg-zinc-100 hover:bg-white text-zinc-950 font-mono text-xs font-bold tracking-wider flex items-center justify-center gap-2 transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5 hover:shadow-[0_8px_30px_rgba(255,255,255,0.14)] group"
              >
                <span>Create workspace</span>
                <ArrowRight className="w-3.5 h-3.5 transition-transform duration-300 group-hover:translate-x-1" />
              </Link>

              <Link
                href="/login"
                className="w-full sm:w-auto py-3 px-6 border border-white/[0.12] hover:border-white/40 bg-zinc-950/70 text-zinc-300 hover:text-white font-mono text-xs tracking-wider flex items-center justify-center gap-2 transition-all duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:-translate-y-0.5"
              >
                <span>Resume session</span>
                <LogIn className="w-3.5 h-3.5 text-zinc-500" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* ===================================================================== */}
      {/* 3. BIZARRO 3D PHYSICS CANVAS & ANALOG MEMORY VAULT                    */}
      {/* ===================================================================== */}
      <section className="relative z-10 py-24 border-b border-white/[0.08] max-w-7xl mx-auto px-6">
        <div className="flex items-center justify-between border-b border-white/[0.08] pb-4 mb-8 text-xs font-mono tracking-wider text-zinc-500">
          <div className="flex items-center gap-2">
            <span className="text-zinc-300 font-semibold">[ 002 ]</span>
            <span>Analog memory vault & physics deck</span>
          </div>
          <div className="hidden sm:block">
            <span>Photorealistic 3D cassettes · Grab & toss inertia</span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center">
          {/* Left Column: Editorial Blueprint */}
          <div className="lg:col-span-5 pt-2">
            <h2 className="text-3xl sm:text-5xl font-light tracking-[-0.025em] text-zinc-100 leading-[1.12]">
              Physical certainty in an ephemeral world.
            </h2>
            <p className="mt-6 text-sm text-zinc-300 font-light leading-relaxed">
              Every workflow step is anchored as an immutable domain record. Like high-bias chrome magnetic tape on a precision reel, once serialized under a PostgreSQL row mutex, transactions leave permanent magnetic footprints.
            </p>

            <div className="mt-8 border border-white/[0.08] bg-zinc-950/60 p-5 font-mono text-xs text-zinc-400 space-y-3 shadow-xl">
              <div className="flex items-center justify-between pb-2 border-b border-white/[0.06]">
                <span className="text-zinc-300">Physics Canvas</span>
                <span className="text-emerald-400 font-medium">Active (60 FPS)</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Interaction mode</span>
                <span className="text-zinc-200">Grab, throw, bounce</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Sound transport</span>
                <span className="text-zinc-200">{tapeWarmth} RPM analog hiss</span>
              </div>
              <div className="flex items-center justify-between">
                <span>Elapsed tape counter</span>
                <span className="text-zinc-200 font-bold">{tapeCounter} s</span>
              </div>
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              <button
                onClick={toggleAmbientAudio}
                className="py-3 px-5 border border-white/[0.12] hover:border-white/40 bg-zinc-950 text-zinc-200 hover:text-white font-mono text-xs tracking-wider flex items-center gap-2 transition-all duration-300"
              >
                {ambientAudioActive ? (
                  <>
                    <Pause className="w-3.5 h-3.5" />
                    <span>Pause tape deck</span>
                  </>
                ) : (
                  <>
                    <Play className="w-3.5 h-3.5" />
                    <span>Engage tape audio</span>
                  </>
                )}
              </button>

              <button
                onClick={handleScrambleCassettes}
                className="py-3 px-4 border border-white/[0.12] hover:border-zinc-500 bg-zinc-950 text-zinc-300 hover:text-white font-mono text-xs tracking-wider transition-all duration-300"
                title="Apply physical impulse to tapes"
              >
                Toss tapes
              </button>

              <button
                onClick={toggleTapeSpeed}
                disabled={!ambientAudioActive}
                className="py-3 px-3.5 border border-white/[0.12] hover:border-zinc-500 bg-zinc-950 text-zinc-400 hover:text-zinc-200 font-mono text-xs tracking-wider disabled:opacity-40 transition-all duration-300"
              >
                EQ: {tapeWarmth}
              </button>
            </div>
          </div>

          {/* Right Column: Full-Bleed Interactive 3D Physics Canvas */}
          <div className="lg:col-span-7 flex flex-col items-center">
            <div className="relative w-full h-[480px] border border-white/[0.08] bg-zinc-950/90 overflow-hidden shadow-2xl">
              <canvas
                ref={physicsCanvasRef}
                width={720}
                height={480}
                onPointerDown={handlePhysicsPointerDown}
                onPointerMove={handlePhysicsPointerMove}
                onPointerUp={handlePhysicsPointerUp}
                className="w-full h-full cursor-grab active:cursor-grabbing"
              />

              {/* Bizarro Technical Colophon HUD Over Canvas */}
              <div className="pointer-events-none absolute top-4 left-4 font-mono text-[10px] text-zinc-400 space-y-1">
                <div>[ SONY SUPER CHROME CASSETTE RIG ]</div>
                <div>PHYSICS: RIGID_BODY_2D_3D_PROJECTED</div>
              </div>

              <div className="pointer-events-none absolute bottom-4 right-4 font-mono text-[10px] text-zinc-400 text-right">
                <div>CLICK & FLING ANY CASSETTE</div>
                <div>BOUNCE COEFFICIENT: 0.72</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===================================================================== */}
      {/* 4. FLUID ARCHITECTURAL GALLERY (REFINED NON-AWKWARD RUNWAY)           */}
      {/* ===================================================================== */}
      <section className="relative z-10 py-24 border-b border-white/[0.08] max-w-7xl mx-auto px-6">
        <div className="flex items-center justify-between border-b border-white/[0.08] pb-4 mb-8 text-xs font-mono tracking-wider text-zinc-500">
          <div className="flex items-center gap-2">
            <span className="text-zinc-300 font-semibold">[ 003 ]</span>
            <span>Deterministic system invariant gallery</span>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono text-zinc-400">
            <span>Chapter {activeChapterIndex + 1} of {CHAPTERS.length}</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => handleSelectChapter(Math.max(0, activeChapterIndex - 1))}
                disabled={activeChapterIndex === 0}
                className="p-1 border border-white/[0.1] hover:border-white/40 disabled:opacity-20 transition-all"
                title="Previous chapter"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => handleSelectChapter(Math.min(CHAPTERS.length - 1, activeChapterIndex + 1))}
                disabled={activeChapterIndex === CHAPTERS.length - 1}
                className="p-1 border border-white/[0.1] hover:border-white/40 disabled:opacity-20 transition-all"
                title="Next chapter"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Chapter Quick Tabs */}
        <div className="flex items-center gap-2 overflow-x-auto pb-4 mb-8 scrollbar-none">
          {CHAPTERS.map((ch, idx) => (
            <button
              key={ch.id}
              onClick={() => handleSelectChapter(idx)}
              className={`px-3 py-1.5 font-mono text-xs whitespace-nowrap border transition-all duration-300 ${
                activeChapterIndex === idx
                  ? "border-white bg-zinc-100 text-zinc-950 font-semibold shadow-lg"
                  : "border-white/[0.08] bg-zinc-950/60 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
              }`}
            >
              [ {ch.index} ] {ch.title.split("&")[0].trim()}
            </button>
          ))}
        </div>

        {/* Selected Chapter Showcase Deck */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 border border-white/[0.08] bg-gradient-to-b from-zinc-950/90 to-[#0c0c12]/90 backdrop-blur-xl p-8 shadow-2xl">
          {/* Left Column: Narrative, Quote, Metrics */}
          <div className="lg:col-span-5 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between text-xs font-mono text-zinc-400 pb-3 border-b border-white/[0.08]">
                <span className="text-zinc-200 font-semibold">[ Chapter {CHAPTERS[activeChapterIndex].index} ]</span>
                <span>{CHAPTERS[activeChapterIndex].subtitle}</span>
              </div>

              <h3 className="text-2xl sm:text-4xl font-light text-zinc-100 tracking-tight mt-6 leading-snug">
                {CHAPTERS[activeChapterIndex].title}
              </h3>

              <p className="text-sm text-zinc-300 font-light leading-relaxed mt-4">
                {CHAPTERS[activeChapterIndex].detail}
              </p>

              <blockquote className="mt-6 border-l-2 border-white/20 pl-4 text-xs font-serif italic text-zinc-400">
                &ldquo;{CHAPTERS[activeChapterIndex].quote}&rdquo;
              </blockquote>
            </div>

            {/* Metrics */}
            <div className="grid grid-cols-3 gap-3 mt-8 pt-6 border-t border-white/[0.08]">
              {CHAPTERS[activeChapterIndex].metrics.map((m, i) => (
                <div key={i} className="font-mono">
                  <div className="text-[10px] text-zinc-400 uppercase tracking-wider">{m.label}</div>
                  <div className="text-xs text-zinc-200 font-semibold mt-1 truncate">{m.value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Right Column: High-End Code Inspector */}
          <div className="lg:col-span-7 flex flex-col justify-between border border-white/[0.08] bg-[#07070a] shadow-inner">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/[0.08] bg-zinc-950 font-mono text-xs text-zinc-400">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 border border-zinc-700 bg-zinc-900 inline-block" />
                <span className="text-zinc-200">{CHAPTERS[activeChapterIndex].fileName}</span>
              </div>

              <button
                onClick={() => handleCopyCode(CHAPTERS[activeChapterIndex].code)}
                className="flex items-center gap-1.5 text-[11px] hover:text-white transition-colors"
                title="Copy code contract to clipboard"
              >
                {copiedCode ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="text-emerald-400">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copy</span>
                  </>
                )}
              </button>
            </div>

            <div className="p-5 font-mono text-xs text-zinc-300 overflow-x-auto leading-relaxed">
              <pre className="text-zinc-300">
                {CHAPTERS[activeChapterIndex].code}
              </pre>
            </div>

            <div className="px-4 py-2 border-t border-white/[0.06] bg-zinc-950/50 flex items-center justify-between text-[10px] font-mono text-zinc-500">
              <span>PRISMA 7.3.0 · PG DRIVER ADAPTER · READ COMMITTED</span>
              <span>100% PRODUCTION VERIFIED</span>
            </div>
          </div>
        </div>
      </section>

      {/* ===================================================================== */}
      {/* 5. INTERACTIVE DAG WORKFLOW ENGINE DEMO                                */}
      {/* ===================================================================== */}
      <section className="relative z-10 py-24 border-b border-white/[0.08] max-w-7xl mx-auto px-6">
        <div className="flex items-center justify-between border-b border-white/[0.08] pb-4 mb-12 text-xs font-mono tracking-wider text-zinc-500">
          <div className="flex items-center gap-2">
            <span className="text-zinc-300 font-semibold">[ 004 ]</span>
            <span>Interactive DAG workflow execution simulator</span>
          </div>
          <div className="hidden sm:block">
            <span>Deterministic step resolution & compensation</span>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Node Selector */}
          <div className="lg:col-span-5 space-y-3">
            {DAG_NODES.map((node, index) => {
              const isSelected = selectedDagIndex === index;
              return (
                <button
                  key={node.id}
                  onClick={() => {
                    setSelectedDagIndex(index);
                    playMechanicalClick(audioCtxRef.current);
                  }}
                  className={`w-full text-left p-4 border transition-all duration-300 ${
                    isSelected
                      ? "border-white bg-zinc-900/90 text-white shadow-lg"
                      : "border-white/[0.08] bg-zinc-950/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
                  }`}
                >
                  <div className="flex items-center justify-between text-[10px] font-mono mb-1">
                    <span className={isSelected ? "text-white font-bold" : "text-zinc-500"}>
                      [ {node.stepNumber} ]
                    </span>
                    <span className="text-zinc-400">{node.category}</span>
                  </div>
                  <div className="font-mono text-sm font-semibold tracking-tight">{node.label}</div>
                </button>
              );
            })}
          </div>

          {/* Node Inspector */}
          <div className="lg:col-span-7 border border-white/[0.08] bg-zinc-950/80 p-8 shadow-2xl">
            <div className="flex items-center justify-between border-b border-white/[0.08] pb-4 font-mono text-xs">
              <span className="text-zinc-400">Node Invariant Contract</span>
              <span className="text-zinc-200 font-semibold">{DAG_NODES[selectedDagIndex].label}</span>
            </div>

            <div className="mt-6 space-y-6 font-mono text-xs">
              <div>
                <div className="text-zinc-400 uppercase tracking-wider text-[10px]">Execution Contract</div>
                <div className="mt-2 p-3 bg-black/60 border border-white/[0.06] text-zinc-200 break-all leading-relaxed">
                  {DAG_NODES[selectedDagIndex].signature}
                </div>
              </div>

              <div>
                <div className="text-zinc-400 uppercase tracking-wider text-[10px]">Saga Rollback Compensation</div>
                <div className="mt-2 p-3 bg-black/60 border border-white/[0.06] text-zinc-300 break-all leading-relaxed">
                  {DAG_NODES[selectedDagIndex].compensation}
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===================================================================== */}
      {/* 6. COLOPHON & MINIMALIST FOOTER (BIZARRO FOUR-CORNER HUD)             */}
      {/* ===================================================================== */}
      <footer className="relative z-10 py-16 max-w-7xl mx-auto px-6">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8 text-xs font-mono text-zinc-400">
          <div>
            <div className="font-bold text-zinc-100 uppercase tracking-widest mb-3">Forge System</div>
            <p className="text-zinc-400 font-light leading-relaxed">
              Quiet, deterministic orchestration for high-velocity engineering organizations.
            </p>
          </div>

          <div>
            <div className="font-bold text-zinc-200 uppercase tracking-widest mb-3">Guarantees</div>
            <ul className="space-y-1.5 text-zinc-400">
              <li>PostgreSQL row mutex</li>
              <li>CDC transactional outbox</li>
              <li>Reverse saga rollback</li>
              <li>Scoped Pinecone tombstones</li>
            </ul>
          </div>

          <div>
            <div className="font-bold text-zinc-200 uppercase tracking-widest mb-3">Endpoints</div>
            <ul className="space-y-1.5">
              <li>
                <Link href="/login" className="hover:text-white transition-colors">
                  Sign in
                </Link>
              </li>
              <li>
                <Link href="/signup" className="hover:text-white transition-colors">
                  Create account
                </Link>
              </li>
              <li>
                <Link href="/select-org" className="hover:text-white transition-colors">
                  Select organization
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <div className="font-bold text-zinc-200 uppercase tracking-widest mb-3">Colophon</div>
            <p className="text-zinc-400 leading-relaxed">
              Designed with late-night aesthetic restraint. Zero pills. Zero oscillating points. Real physics & spatial typography.
            </p>
          </div>
        </div>

        <div className="mt-12 pt-8 border-t border-white/[0.08] flex flex-col sm:flex-row items-center justify-between text-[11px] font-mono text-zinc-400">
          <div>© {new Date().getFullYear()} Forge Technologies Inc. All rights reserved.</div>
          <div className="mt-2 sm:mt-0">Production M1 Certified · Branch: feat/m1-identity-and-latenight-landing</div>
        </div>
      </footer>
    </div>
  );
}

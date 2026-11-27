"use client";

import React, { useState, useEffect, useRef } from "react";
import { Play, RotateCcw, AlertTriangle, CheckCircle2, Cpu, Zap, ArrowRight, ShieldCheck, Database, Layers } from "lucide-react";

interface NodeData {
  id: string;
  kind: "trigger" | "action";
  label: string;
  typeBadge: string;
  description: string;
  status: "idle" | "running" | "success" | "error" | "compensating";
  durationMs?: number;
  isolation: string;
  payload: Record<string, any>;
  output?: Record<string, any>;
}

interface EdgeData {
  from: string;
  to: string;
  label?: string;
}

const INITIAL_NODES: NodeData[] = [
  {
    id: "node_trg",
    kind: "trigger",
    label: "CDC Outbox Event",
    typeBadge: "orders.created",
    description: "Postgres logical replication stream",
    status: "idle",
    isolation: "SERIALIZABLE",
    payload: {
      orderId: "ord_99014",
      tenantId: "tenant_acme",
      amountCents: 18450,
      currency: "USD",
      timestamp: 1732733912000,
    },
    output: {
      orderId: "ord_99014",
      userEmail: "ops@acmeworks.internal",
    },
  },
  {
    id: "node_act_1",
    kind: "action",
    label: "Fraud Scoring Mutex",
    typeBadge: "risk_engine.evaluate",
    description: "Distributed lock with risk evaluation",
    status: "idle",
    isolation: "PESSIMISTIC_READ",
    payload: {
      riskThreshold: 0.85,
      ipScore: 0.04,
      velocityCheck: "PASS",
    },
    output: {
      riskScore: 0.08,
      decision: "ALLOW",
    },
  },
  {
    id: "node_act_2",
    kind: "action",
    label: "Stripe Atomic Hold",
    typeBadge: "payment.authorize",
    description: "Two-phase commit payment authorization",
    status: "idle",
    isolation: "READ_COMMITTED",
    payload: {
      idempotencyKey: "idem_8f7b3c0e",
      captureMethod: "MANUAL",
      amountCents: 18450,
    },
    output: {
      chargeId: "ch_3Pz5G42eZvKYlo2C",
      authStatus: "HOLD_PLACED",
    },
  },
  {
    id: "node_act_3",
    kind: "action",
    label: "Postgres Inventory Lock",
    typeBadge: "inventory.reserve",
    description: "Row-level lock on SKU inventory",
    status: "idle",
    isolation: "REPEATABLE_READ",
    payload: {
      sku: "SKU_FORGE_BLADE_01",
      quantity: 1,
      lockType: "FOR_UPDATE",
    },
    output: {
      reservedStockId: "res_31104",
      warehouseZone: "US-EAST-RACK-4",
    },
  },
  {
    id: "node_act_4",
    kind: "action",
    label: "Dispatch Webhook",
    typeBadge: "shipping.dispatch",
    description: "Signed HMAC-SHA256 event emitter",
    status: "idle",
    isolation: "AT_LEAST_ONCE",
    payload: {
      channel: "wbh_fulfill_44",
      signatureAlg: "hmac-sha256",
      maxRetries: 3,
    },
    output: {
      dispatchId: "dsp_89412",
      deliveredAt: "2026-11-27T14:32:01Z",
    },
  },
];

const EDGES: EdgeData[] = [
  { from: "node_trg", to: "node_act_1" },
  { from: "node_act_1", to: "node_act_2" },
  { from: "node_act_2", to: "node_act_3" },
  { from: "node_act_3", to: "node_act_4" },
];

export function InteractiveWorkflowShowcase() {
  const [nodes, setNodes] = useState<NodeData[]>(INITIAL_NODES);
  const [selectedNodeId, setSelectedNodeId] = useState<string>("node_trg");
  const [isSimulating, setIsSimulating] = useState(false);
  const [simMode, setSimMode] = useState<"none" | "success" | "rollback">("none");
  const [activeStepIndex, setActiveStepIndex] = useState<number>(-1);
  const [logMessages, setLogMessages] = useState<string[]>([
    "DAG loaded: 5 nodes, 4 deterministic causal dependencies.",
    "Ready for simulation execution or atomic saga compensation.",
  ]);

  const simulationTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Clear timers on unmount
  useEffect(() => {
    return () => {
      if (simulationTimerRef.current) clearTimeout(simulationTimerRef.current);
    };
  }, []);

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || nodes[0];

  const appendLog = (msg: string) => {
    setLogMessages((prev) => [msg, ...prev.slice(0, 19)]);
  };

  const handleReset = () => {
    if (simulationTimerRef.current) clearTimeout(simulationTimerRef.current);
    setIsSimulating(false);
    setSimMode("none");
    setActiveStepIndex(-1);
    setNodes(INITIAL_NODES);
    appendLog("Canvas state reset to idle baseline.");
  };

  const runSimulation = () => {
    if (isSimulating) return;
    handleReset();
    setIsSimulating(true);
    setSimMode("success");
    appendLog("Initiating topological execution sequence [mode: FORWARD_EXECUTION]...");

    const delays = [450, 600, 750, 500, 650];
    const executionDurations = [14, 48, 112, 38, 22];

    const runStep = (idx: number) => {
      if (idx >= nodes.length) {
        setIsSimulating(false);
        setActiveStepIndex(-1);
        appendLog("✓ DAG execution completed successfully. All invariants preserved (234ms total).");
        return;
      }

      setActiveStepIndex(idx);
      const targetNode = nodes[idx];

      // Mark running
      setNodes((prev) =>
        prev.map((n, i) => (i === idx ? { ...n, status: "running" } : n))
      );
      appendLog(`→ [STEP ${idx + 1}/${nodes.length}] Executing ${targetNode.label} (${targetNode.typeBadge})...`);

      simulationTimerRef.current = setTimeout(() => {
        // Mark success
        setNodes((prev) =>
          prev.map((n, i) =>
            i === idx ? { ...n, status: "success", durationMs: executionDurations[idx] } : n
          )
        );
        appendLog(`✓ Node ${targetNode.label} completed in ${executionDurations[idx]}ms.`);

        simulationTimerRef.current = setTimeout(() => {
          runStep(idx + 1);
        }, 150);
      }, delays[idx]);
    };

    simulationTimerRef.current = setTimeout(() => {
      runStep(0);
    }, 200);
  };

  const runSagaRollback = () => {
    if (isSimulating) return;
    handleReset();
    setIsSimulating(true);
    setSimMode("rollback");
    appendLog("Initiating failure simulation with atomic Saga compensation...");

    // Step 0: Trigger
    setActiveStepIndex(0);
    setNodes((prev) =>
      prev.map((n, i) => (i === 0 ? { ...n, status: "running" } : n))
    );

    simulationTimerRef.current = setTimeout(() => {
      setNodes((prev) =>
        prev.map((n, i) => (i === 0 ? { ...n, status: "success", durationMs: 12 } : n))
      );
      appendLog("✓ Step 1 Trigger verified.");

      // Step 1: Fraud Check
      setActiveStepIndex(1);
      setNodes((prev) =>
        prev.map((n, i) => (i === 1 ? { ...n, status: "running" } : n))
      );

      simulationTimerRef.current = setTimeout(() => {
        setNodes((prev) =>
          prev.map((n, i) => (i === 1 ? { ...n, status: "success", durationMs: 42 } : n))
        );
        appendLog("✓ Step 2 Fraud Scoring passed.");

        // Step 2: Stripe Hold
        setActiveStepIndex(2);
        setNodes((prev) =>
          prev.map((n, i) => (i === 2 ? { ...n, status: "running" } : n))
        );

        simulationTimerRef.current = setTimeout(() => {
          setNodes((prev) =>
            prev.map((n, i) => (i === 2 ? { ...n, status: "success", durationMs: 105 } : n))
          );
          appendLog("✓ Step 3 Stripe hold authorized ($184.50).");

          // Step 3: Inventory Lock Fails!
          setActiveStepIndex(3);
          setNodes((prev) =>
            prev.map((n, i) => (i === 3 ? { ...n, status: "running" } : n))
          );

          simulationTimerRef.current = setTimeout(() => {
            setNodes((prev) =>
              prev.map((n, i) => (i === 3 ? { ...n, status: "error" } : n))
            );
            appendLog("✖ Step 4 FAILED: Inventory allocation conflict: SKU_FORGE_BLADE_01 locked by foreign tenant.");
            appendLog("⚡ ENGAGING REVERSE SAGA COMPENSATION CASCADE...");

            // Compensate Node 2 (Stripe Release)
            simulationTimerRef.current = setTimeout(() => {
              setActiveStepIndex(2);
              setNodes((prev) =>
                prev.map((n, i) => (i === 2 ? { ...n, status: "compensating" } : n))
              );
              appendLog("↩ Compensating Step 3: Voiding Stripe authorization hold ch_3Pz5G42eZvKYlo2C...");

              simulationTimerRef.current = setTimeout(() => {
                setNodes((prev) =>
                  prev.map((n, i) =>
                    i === 2
                      ? {
                          ...n,
                          status: "idle",
                          description: "Hold released via reverse saga",
                        }
                      : n
                  )
                );
                appendLog("✓ Stripe hold successfully voided. Zero orphaned charges.");

                // Compensate Node 1 (Release Mutex)
                setActiveStepIndex(1);
                setNodes((prev) =>
                  prev.map((n, i) => (i === 1 ? { ...n, status: "compensating" } : n))
                );
                appendLog("↩ Compensating Step 2: Releasing fraud scoring mutex lock...");

                simulationTimerRef.current = setTimeout(() => {
                  setNodes((prev) =>
                    prev.map((n, i) =>
                      i === 1
                        ? {
                            ...n,
                            status: "idle",
                            description: "Mutex cleanly released",
                          }
                        : n
                    )
                  );
                  appendLog("✓ Mutex released. Distributed state cleanly rolled back with 0 leak.");
                  setIsSimulating(false);
                  setActiveStepIndex(-1);
                }, 800);
              }, 900);
            }, 800);
          }, 850);
        }, 800);
      }, 700);
    }, 500);
  };

  return (
    <div className="w-full bg-[#07070a] border border-white/[0.08] shadow-[0_20px_50px_rgba(0,0,0,0.8)] overflow-hidden">
      {/* Top Header Bar */}
      <div className="flex flex-wrap items-center justify-between border-b border-white/[0.08] px-4 py-3 bg-zinc-950/80 gap-3">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.7)]" />
          <span className="font-mono text-xs font-semibold uppercase tracking-wider text-zinc-200">
            Interactive DAG Simulation Engine
          </span>
          <span className="hidden sm:inline-block font-mono text-[11px] text-zinc-500 border-l border-white/[0.08] pl-3">
            Deterministic Saga Execution · 100% Invariant Guarantee
          </span>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={runSimulation}
            disabled={isSimulating}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-white/[0.15] bg-zinc-900 hover:bg-zinc-800 text-zinc-100 hover:text-white font-mono text-xs font-medium tracking-wider transition-all disabled:opacity-40"
            title="Execute pipeline in forward direction"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>Simulate DAG</span>
          </button>

          <button
            onClick={runSagaRollback}
            disabled={isSimulating}
            className="flex items-center gap-1.5 px-3 py-1.5 border border-amber-500/30 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 font-mono text-xs font-medium tracking-wider transition-all disabled:opacity-40"
            title="Trigger deliberate failure to demonstrate atomic compensation"
          >
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>Simulate Saga Rollback</span>
          </button>

          <button
            onClick={handleReset}
            disabled={isSimulating}
            className="flex items-center gap-1 px-2.5 py-1.5 border border-white/[0.08] bg-zinc-950 text-zinc-400 hover:text-zinc-200 font-mono text-xs transition-all disabled:opacity-40"
            title="Reset DAG canvas"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Main Interactive Stage */}
      <div className="grid grid-cols-1 lg:grid-cols-12 min-h-[460px]">
        {/* Left 8 Cols: Visual Interactive DAG Graph */}
        <div className="lg:col-span-8 p-6 relative flex flex-col justify-between overflow-x-auto bg-[#07070a]/95 select-none">
          {/* Subtle Technical Canvas Grid Background */}
          <div
            className="absolute inset-0 pointer-events-none opacity-[0.035]"
            style={{
              backgroundImage: `radial-gradient(circle at 1px 1px, #ffffff 1px, transparent 0)`,
              backgroundSize: "24px 24px",
            }}
          />

          {/* Scenario Headline */}
          <div className="relative z-10 flex items-center justify-between mb-4 pb-2 border-b border-white/[0.06] text-xs font-mono text-zinc-500">
            <span className="flex items-center gap-2">
              <span className="text-zinc-400 font-semibold">PIPELINE:</span>
              <span className="text-zinc-200">E-Commerce Transaction Settlement</span>
            </span>
            <span className="text-[11px] text-zinc-400">
              {simMode === "none" && "STATUS: IDLE"}
              {simMode === "success" && (
                <span className="text-zinc-200 font-semibold animate-pulse">
                  STATUS: EXECUTING ({activeStepIndex + 1}/5)
                </span>
              )}
              {simMode === "rollback" && (
                <span className="text-amber-400 font-semibold animate-pulse">
                  STATUS: REVERSING COMPENSATION CASCADE
                </span>
              )}
            </span>
          </div>

          {/* DAG Visual Nodes Chain */}
          <div className="relative z-10 my-auto py-6 space-y-4">
            {nodes.map((node, index) => {
              const isSelected = selectedNodeId === node.id;
              const isTrigger = node.kind === "trigger";
              const hasNext = index < nodes.length - 1;

              return (
                <div key={node.id} className="relative">
                  {/* The Node Card */}
                  <div
                    onClick={() => setSelectedNodeId(node.id)}
                    className={`cursor-pointer transition-all duration-200 p-3.5 border rounded-none relative flex flex-col sm:flex-row sm:items-center justify-between gap-3 ${
                      isSelected
                        ? "ring-1 ring-white/40 shadow-[0_0_20px_rgba(255,255,255,0.06)]"
                        : "hover:border-zinc-500"
                    } ${
                      isTrigger
                        ? "border-amber-500/25 bg-[#0f0e0b]/90 text-amber-200"
                        : "border-indigo-500/25 bg-[#0c0d16]/90 text-indigo-200"
                    } ${
                      node.status === "running"
                        ? "border-white bg-white/[0.06] shadow-[0_0_15px_rgba(255,255,255,0.15)]"
                        : ""
                    } ${
                      node.status === "error"
                        ? "border-red-500/50 bg-red-950/20 text-red-300"
                        : ""
                    } ${
                      node.status === "compensating"
                        ? "border-amber-400 bg-amber-950/30 text-amber-200 animate-pulse"
                        : ""
                    }`}
                  >
                    {/* Left indicator bar */}
                    <div
                      className={`absolute left-0 top-0 bottom-0 w-1 ${
                        node.status === "running"
                          ? "bg-white"
                          : node.status === "success"
                          ? "bg-zinc-200"
                          : node.status === "error"
                          ? "bg-red-500"
                          : node.status === "compensating"
                          ? "bg-amber-400"
                          : isTrigger
                          ? "bg-amber-500/60"
                          : "bg-indigo-500/60"
                      }`}
                    />

                    {/* Node Metadata & Title */}
                    <div className="pl-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`text-[9px] font-mono px-1.5 py-0.5 border ${
                            isTrigger
                              ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                              : "border-indigo-500/30 bg-indigo-500/10 text-indigo-300"
                          }`}
                        >
                          {isTrigger ? "TRIGGER" : "ACTION"}
                        </span>
                        <span className="font-mono text-xs font-semibold text-zinc-100">
                          {node.label}
                        </span>
                      </div>
                      <div className="mt-1 font-mono text-[11px] text-zinc-400">
                        {node.typeBadge} · <span className="text-zinc-500">{node.description}</span>
                      </div>
                    </div>

                    {/* Right Status Badge */}
                    <div className="flex items-center gap-3 sm:self-center font-mono text-xs pl-2 sm:pl-0">
                      {node.status === "idle" && (
                        <span className="text-zinc-500 text-[11px]">READY</span>
                      )}
                      {node.status === "running" && (
                        <span className="flex items-center gap-1.5 text-zinc-100 font-medium text-[11px] animate-pulse">
                          <span className="w-1.5 h-1.5 rounded-full bg-white" />
                          EXECUTING...
                        </span>
                      )}
                      {node.status === "success" && (
                        <span className="flex items-center gap-1.5 text-zinc-200 font-medium text-[11px]">
                          <CheckCircle2 className="w-3.5 h-3.5 text-zinc-100" />
                          <span>{node.durationMs ? `${node.durationMs}ms` : "OK"}</span>
                        </span>
                      )}
                      {node.status === "error" && (
                        <span className="flex items-center gap-1.5 text-red-400 font-medium text-[11px]">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          <span>FAILED (ROW_LOCK_TIMEOUT)</span>
                        </span>
                      )}
                      {node.status === "compensating" && (
                        <span className="flex items-center gap-1.5 text-amber-300 font-medium text-[11px]">
                          <RotateCcw className="w-3.5 h-3.5 animate-spin" />
                          <span>COMPENSATING...</span>
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Connecting Edge Indicator */}
                  {hasNext && (
                    <div className="flex items-center justify-center my-1">
                      <div
                        className={`h-4 w-[1px] transition-colors duration-300 ${
                          activeStepIndex === index && isSimulating
                            ? "bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)] scale-y-125"
                            : "bg-white/[0.12]"
                        }`}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Quick Helper */}
          <div className="relative z-10 text-[10px] font-mono text-zinc-500 pt-3 border-t border-white/[0.06] flex items-center justify-between">
            <span>Click any node to inspect atomic contracts & state invariants</span>
            <span>Click buttons above for live visual execution</span>
          </div>
        </div>

        {/* Right 4 Cols: Live Inspector & State Audit Console */}
        <div className="lg:col-span-4 border-t lg:border-t-0 lg:border-l border-white/[0.08] bg-zinc-950/90 flex flex-col justify-between">
          {/* Top: Node Property Inspector */}
          <div className="p-4 border-b border-white/[0.08]">
            <div className="flex items-center justify-between text-xs font-mono text-zinc-500 mb-2.5">
              <span>NODE INSPECTOR</span>
              <span className="text-zinc-400 font-semibold">{selectedNode.id}</span>
            </div>

            <div className="space-y-3 font-mono text-xs">
              <div className="bg-[#0c0c10] border border-white/[0.08] p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">Operation:</span>
                  <span className="text-zinc-200 font-semibold">{selectedNode.label}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">Isolation Level:</span>
                  <span className="text-zinc-300">{selectedNode.isolation}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-zinc-500">State Transition:</span>
                  <span
                    className={
                      selectedNode.status === "success"
                        ? "text-zinc-100 font-bold"
                        : selectedNode.status === "error"
                        ? "text-red-400 font-bold"
                        : "text-zinc-400"
                    }
                  >
                    {selectedNode.status.toUpperCase()}
                  </span>
                </div>
              </div>

              {/* JSON Payload Inspection */}
              <div>
                <span className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">
                  Input Contract (Immutable Payload)
                </span>
                <pre className="p-2.5 bg-black/60 border border-white/[0.06] text-[11px] text-zinc-300 font-mono overflow-x-auto max-h-36 select-all">
                  {JSON.stringify(selectedNode.payload, null, 2)}
                </pre>
              </div>

              {selectedNode.output && (
                <div>
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider block mb-1">
                    Output Verification Artifact
                  </span>
                  <pre className="p-2.5 bg-black/60 border border-white/[0.06] text-[11px] text-zinc-300 font-mono overflow-x-auto max-h-28 select-all">
                    {JSON.stringify(selectedNode.output, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          </div>

          {/* Bottom: Deterministic Telemetry Stream */}
          <div className="p-4 bg-black/40">
            <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 mb-2">
              <span className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-white/70" />
                EXECUTION TELEMETRY
              </span>
              <span>{logMessages.length} entries</span>
            </div>
            <div className="font-mono text-[10px] text-zinc-400 space-y-1 max-h-32 overflow-y-auto pr-1">
              {logMessages.map((msg, i) => (
                <div
                  key={i}
                  className={`leading-tight ${
                    msg.includes("✓")
                      ? "text-zinc-200"
                      : msg.includes("✖")
                      ? "text-red-400"
                      : msg.includes("⚡") || msg.includes("↩")
                      ? "text-amber-300"
                      : "text-zinc-500"
                  }`}
                >
                  {msg}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default InteractiveWorkflowShowcase;

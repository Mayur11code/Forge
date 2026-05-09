"use client";

import { useState } from "react";
import { useReactFlow, useOnSelectionChange, useNodesData } from "@xyflow/react";
import { AVAILABLE_ACTIONS, AVAILABLE_TRIGGERS } from "../../../../lib/workflow-types/registry";
import { useMemo } from "react"; // Add to 'react' import
import { getAvailableUpstreamOutputs, getNodeDefinition, autoMapNodeVariables } from "@/lib/workflow/graph-ui/utils";
import { ActionDef } from "@/lib/workflow-types/registry";
import { useEdges } from "@xyflow/react"; // Add to '@xyflow/react'

// 1. IMPORT YOUR REAL TYPES
import type { TriggerNodeData, ActionNodeData, AppEdge, AppNode } from "@/lib/workflow-types/workflow";

// 2. THE STRICT DISCRIMINATED UNION
// React Flow's useNodesData returns an object with { id, type, data }.
// By defining this union, we teach TypeScript to link the 'type' string directly to your real Zod-inferred schemas.
type LiveNodeMatch =
  | { id: string; type: 'trigger'; data: TriggerNodeData }
  | { id: string; type: 'action'; data: ActionNodeData };




export default function PropertiesPanel() {
  const { updateNodeData } = useReactFlow();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  useOnSelectionChange({
    onChange: ({ nodes }) => {
      setSelectedNodeId(nodes.length > 0 ? nodes[0].id : null);
    },
  });

  // 3. APPLY THE UNION
  // We cast the hook's return value to our strict union. 
  // From this point down, TypeScript's strict mode does all the heavy lifting automatically.
  const nodeMatch = useNodesData(selectedNodeId!) as LiveNodeMatch | undefined;

  const { getNodes, setNodes } = useReactFlow<AppNode, AppEdge>();
  const edges = useEdges(); // Hook to stay reactive to wire changes

  // Calculate validation state for the sidebar
  const { missingVariables, hasGraphError } = useMemo(() => {
    if (!nodeMatch || nodeMatch.type !== "action") return { missingVariables: [], hasGraphError: false };

    const actionDef = getNodeDefinition(nodeMatch as any) as ActionDef | undefined;
    if (!actionDef?.requires) return { missingVariables: [], hasGraphError: false };

    const upstream = getAvailableUpstreamOutputs(selectedNodeId!, getNodes() as any, edges as any);
    const availableKeys = upstream.map((out) => out.outputKey);
    const missing = actionDef.requires.filter((req) => !availableKeys.includes(req));

    return { missingVariables: missing, hasGraphError: missing.length > 0 };
  }, [nodeMatch, selectedNodeId, getNodes, edges]);

  if (!selectedNodeId || !nodeMatch) {
    return (
      <aside className="w-80 border-l border-zinc-800 bg-[#0a0a0a] p-6 flex items-center justify-center text-zinc-500 text-sm italic font-mono">
        Select a node to configure
      </aside>
    );
  }

  // 4. BULLETPROOF MUTATOR
  const updateConfig = (key: string, value: string) => {
    // Because of the union, the moment we check this...
    if (nodeMatch.type !== "action") return;

    // ...TypeScript KNOWS nodeMatch.data is ActionNodeData!
    // Notice how you get perfect autocomplete for .config here.
    const currentConfig = nodeMatch.data.config || {};

    updateNodeData(selectedNodeId, {
      config: { ...currentConfig, [key]: value },
      isConfigured: true,
    });
  };

  return (
    <aside className="w-80 border-l border-zinc-800 bg-[#0a0a0a] p-4 flex flex-col gap-6 overflow-y-auto">

      {/* HEADER */}
      <div>
        <h2 className="text-sm font-bold text-zinc-100 uppercase tracking-widest mb-1">
          {nodeMatch.type === 'trigger' ? 'Trigger' : 'Action'} Configuration
        </h2>
        <p className="text-[10px] text-zinc-600 font-mono bg-zinc-900/50 p-1 rounded break-all">
          ID: {selectedNodeId}
        </p>
      </div>

      {/* --- TRIGGER UI --- */}
      {/* The moment we enter this block, TS knows nodeMatch.data is strictly TriggerNodeData */}
      {nodeMatch.type === "trigger" && (
        <div className="flex flex-col gap-2">
          <label className="text-xs font-semibold text-zinc-400">Event Type</label>
          <select
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500 transition-colors"
            value={nodeMatch.data.eventId || ""}
            // Update the Trigger onChange
            onChange={(e) => {
              const selectedTrigger = AVAILABLE_TRIGGERS.find(t => t.id === e.target.value);
              updateNodeData(selectedNodeId, {
                eventId: e.target.value,
                label: selectedTrigger?.label || "Trigger"
              });

              // NEW: When a trigger changes, it might satisfy downstream actions.
              // We trigger the mapper for the whole graph to ensure children update.
              getNodes().forEach(n => {
                if (n.type === 'action') autoMapNodeVariables(n.id, getNodes() as any, edges as any, setNodes);
              });
            }}
          >
            <option value="" disabled>Select an event...</option>
            {AVAILABLE_TRIGGERS.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
      )}

      {/* --- ACTION UI --- */}
      {/* The moment we enter this block, TS knows nodeMatch.data is strictly ActionNodeData */}
      {nodeMatch.type === "action" && (
        <div className="flex flex-col gap-6">

          {/* ACTION TYPE DROPDOWN */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold text-zinc-400">Action Type</label>
            <select
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500 transition-colors"
              value={nodeMatch.data.actionType || "unset"}
              // Update the Action onChange
              onChange={(e) => {
                const selectedAction = AVAILABLE_ACTIONS.find(a => a.id === e.target.value);

                // 1. Update the type
                updateNodeData(selectedNodeId, {
                  actionType: e.target.value,
                  label: selectedAction?.label || "Action",
                  config: {},
                  isConfigured: false
                });

                // 2. THE SELF-HEALING TRIGGER
                // Immediately check if existing wires can fill this NEW action's needs
                autoMapNodeVariables(
                  selectedNodeId,
                  getNodes() as any,
                  edges as any,
                  setNodes
                );
              }}
            >
              <option value="unset" disabled>Select an action...</option>
              {AVAILABLE_ACTIONS.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </div>

          {/* MISSING REQUIREMENTS ALERT */}
          {hasGraphError && (
            <div className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-3 animate-in fade-in zoom-in duration-200">
              <div className="flex items-center gap-2 mb-2">
                <div className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />
                <p className="text-[10px] font-bold uppercase tracking-widest text-rose-400">
                  Missing Upstream Data
                </p>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed mb-2">
                This action requires variables that aren't reaching it yet. Connect a wire from a node that provides:
              </p>
              <div className="flex flex-wrap gap-1">
                {missingVariables.map((v) => (
                  <span key={v} className="rounded bg-rose-950/30 border border-rose-500/30 px-1.5 py-0.5 font-mono text-[9px] text-rose-300">
                    {v}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* DYNAMIC PROPERTIES FORM */}
          {nodeMatch.data.actionType && nodeMatch.data.actionType !== "unset" && (
            <div className="flex flex-col gap-4 border-t border-zinc-800 pt-5 animate-in fade-in slide-in-from-top-2 duration-200">
              <h3 className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">Properties</h3>

              {AVAILABLE_ACTIONS.find(a => a.id === nodeMatch.data.actionType)?.fields.map((field) => (
                <div key={field.name} className="flex flex-col gap-2">
                  <label className="text-[11px] text-zinc-300">
                    {field.label} {field.required && <span className="text-emerald-500">*</span>}
                  </label>

                  {field.type === 'string' && (
                    <input
                      type="text"
                      className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500 transition-colors"
                      value={nodeMatch.data.config?.[field.name] || ""}
                      onChange={(e) => updateConfig(field.name, e.target.value)}
                      placeholder={`Enter ${field.label.toLowerCase()}...`}
                    />
                  )}

                  {field.type === 'textarea' && (
                    <textarea
                      rows={3}
                      className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500 resize-none transition-colors"
                      value={nodeMatch.data.config?.[field.name] || ""}
                      onChange={(e) => updateConfig(field.name, e.target.value)}
                      placeholder={`Enter ${field.label.toLowerCase()}...`}
                    />
                  )}

                  {field.type === 'select' && (
                    <select
                      className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500 transition-colors"
                      value={nodeMatch.data.config?.[field.name] || ""}
                      onChange={(e) => updateConfig(field.name, e.target.value)}
                    >
                      <option value="" disabled>Select option...</option>
                      {field.options?.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}
"use client";

import { useState } from "react";
import { useReactFlow, useOnSelectionChange, useNodesData } from "@xyflow/react";
import { AVAILABLE_ACTIONS, AVAILABLE_TRIGGERS } from "./registry";
import type { AppNode } from "@/lib/workflow-types/workflow";

// --- HELPER TYPES TO BYPASS TS STRICT UNIONS ---
type SafeTriggerData = { eventId?: string | null; label?: string };
type SafeActionData = { actionType?: string; config?: Record<string, any>; isConfigured?: boolean; label?: string };

export default function PropertiesPanel() {
  const { updateNodeData, getNode } = useReactFlow();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // 1. THE LISTENER: Track only the clicked Node's ID
  useOnSelectionChange({
    onChange: ({ nodes }) => {
      setSelectedNodeId(nodes.length > 0 ? nodes[0].id : null);
    },
  });

  // 2. THE LIVE DATA HOOK: Subscribes only to the selected node
  const nodeMatch = useNodesData(selectedNodeId!);
  const baseNode = selectedNodeId ? getNode(selectedNodeId) : null;

  // 3. EMPTY STATE: Hide panel if nothing is validly selected
  if (!selectedNodeId || !baseNode || !nodeMatch) {
    return (
      <aside className="w-80 border-l border-zinc-800 bg-[#0a0a0a] p-6 flex items-center justify-center text-zinc-500 text-sm italic font-mono">
        Select a node to configure
      </aside>
    );
  }

  // 4. THE TYPESCRIPT FIX: 
  // We force TypeScript to look at the data through specific "lenses"
  // so it stops panicking about missing properties.
  const rawData = nodeMatch.data;
  const triggerData = rawData as SafeTriggerData;
  const actionData = rawData as SafeActionData;

  // 5. THE MUTATOR: Updates specific config fields for actions
  const updateConfig = (key: string, value: string) => {
    if (baseNode.type !== "action") return;
    
    const currentConfig = actionData.config || {};

    updateNodeData(selectedNodeId, {
      config: { ...currentConfig, [key]: value },
      isConfigured: true,
    });
  };

  return (
    <aside className="w-80 border-l border-zinc-800 bg-[#0a0a0a] p-4 flex flex-col gap-6 overflow-y-auto">
      
      {/* --- HEADER --- */}
      <div>
        <h2 className="text-sm font-bold text-zinc-100 uppercase tracking-widest mb-1">
          {baseNode.type === 'trigger' ? 'Trigger' : 'Action'} Configuration
        </h2>
        <p className="text-[10px] text-zinc-600 font-mono bg-zinc-900/50 p-1 rounded break-all">
          ID: {selectedNodeId}
        </p>
      </div>

      {/* --- TRIGGER UI --- */}
      {baseNode.type === "trigger" && (
        <div className="flex flex-col gap-2">
          <label className="text-xs font-semibold text-zinc-400">Event Type</label>
          <select
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500 transition-colors"
            value={triggerData.eventId || ""}
            onChange={(e) => {
              const selectedTrigger = AVAILABLE_TRIGGERS.find(t => t.id === e.target.value);
              updateNodeData(selectedNodeId, {
                eventId: e.target.value,
                label: selectedTrigger?.label || "Trigger"
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
      {baseNode.type === "action" && (
        <div className="flex flex-col gap-6">
          
          {/* ACTION TYPE DROPDOWN */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold text-zinc-400">Action Type</label>
            <select
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500 transition-colors"
              value={actionData.actionType || "unset"}
              onChange={(e) => {
                const selectedAction = AVAILABLE_ACTIONS.find(a => a.id === e.target.value);
                updateNodeData(selectedNodeId, {
                  actionType: e.target.value,
                  label: selectedAction?.label || "Action",
                  config: {}, // Wipe old config clean when type changes
                  isConfigured: false
                });
              }}
            >
              <option value="unset" disabled>Select an action...</option>
              {AVAILABLE_ACTIONS.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </div>

          {/* DYNAMIC PROPERTIES FORM */}
          {actionData.actionType && actionData.actionType !== "unset" && (
            <div className="flex flex-col gap-4 border-t border-zinc-800 pt-5 animate-in fade-in slide-in-from-top-2 duration-200">
              <h3 className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider">Properties</h3>

              {AVAILABLE_ACTIONS.find(a => a.id === actionData.actionType)?.fields.map((field) => (
                <div key={field.name} className="flex flex-col gap-2">
                  <label className="text-[11px] text-zinc-300">
                    {field.label} {field.required && <span className="text-emerald-500">*</span>}
                  </label>

                  {field.type === 'string' && (
                    <input
                      type="text"
                      className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500 transition-colors"
                      value={actionData.config?.[field.name] || ""}
                      onChange={(e) => updateConfig(field.name, e.target.value)}
                      placeholder={`Enter ${field.label.toLowerCase()}...`}
                    />
                  )}

                  {field.type === 'textarea' && (
                    <textarea
                      rows={3}
                      className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500 resize-none transition-colors"
                      value={actionData.config?.[field.name] || ""}
                      onChange={(e) => updateConfig(field.name, e.target.value)}
                      placeholder={`Enter ${field.label.toLowerCase()}...`}
                    />
                  )}

                  {field.type === 'select' && (
                    <select
                      className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-500 transition-colors"
                      value={actionData.config?.[field.name] || ""}
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
"use client";

import { useState } from "react";
import { useReactFlow, useOnSelectionChange } from "@xyflow/react";
import { AVAILABLE_ACTIONS, AVAILABLE_TRIGGERS } from "./registry";
import type { AppNode } from "@/lib/workflow-types/workflow"; // Or your correct path to AppNode

export default function PropertiesPanel() {
  const { setNodes } = useReactFlow(); // This lets us modify nodes on the canvas
  const [selectedNode, setSelectedNode] = useState<AppNode | null>(null);

  // 1. THE LISTENER: React Flow fires this whenever a node is clicked or unclicked
  useOnSelectionChange({
    onChange: ({ nodes }) => {
      // If a node is selected, grab the first one. Otherwise, set to null.
      setSelectedNode((nodes[0] as AppNode) || null);
    },
  });

  // If nothing is clicked, hide the panel gracefully
  if (!selectedNode) {
    return (
      <aside className="w-80 border-l border-zinc-800 bg-[#0a0a0a] p-6 flex items-center justify-center text-zinc-500 text-sm">
        Select a node to configure
      </aside>
    );
  }

  // 2. THE DATA BINDER: This function updates the specific node's memory
  const updateNodeData = (newData: Partial<AppNode["data"]>) => {
    setNodes((currentNodes) =>
      currentNodes.map((node) => {
        if (node.id === selectedNode.id) {
          // Merge the existing data with the new typed input
          return { ...node, data: { ...node.data, ...newData } };
        }
        return node;
      })
    );
  };

  // Helper function specifically for updating the inner `config` object of Action nodes
  const updateConfig = (key: string, value: string) => {
    if (selectedNode.type !== 'action') return;
    const currentConfig = selectedNode.data.config || {};
    updateNodeData({ 
      config: { ...currentConfig, [key]: value },
      // Mark it as configured so the red error border disappears on the canvas!
      isConfigured: true 
    });
  };

  return (
    <aside className="w-80 border-l border-zinc-800 bg-[#0a0a0a] p-4 flex flex-col gap-6 overflow-y-auto">
      <div>
        <h2 className="text-sm font-bold text-zinc-100 uppercase tracking-wider mb-1">
          {selectedNode.type === 'trigger' ? 'Trigger Configuration' : 'Action Configuration'}
        </h2>
        <p className="text-xs text-zinc-500 font-mono">{selectedNode.id}</p>
      </div>

      {/* --- TRIGGER UI --- */}
      {selectedNode.type === "trigger" && (
        <div className="flex flex-col gap-2">
          <label className="text-xs font-semibold text-zinc-400">Event Type</label>
          <select
            className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
            value={selectedNode.data.eventId || ""}
            onChange={(e) => {
              const selectedTrigger = AVAILABLE_TRIGGERS.find(t => t.id === e.target.value);
              updateNodeData({ 
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
      {selectedNode.type === "action" && (
        <div className="flex flex-col gap-6">
          {/* Action Type Dropdown */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-semibold text-zinc-400">Action Type</label>
            <select
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
              value={selectedNode.data.actionType || "unset"}
              onChange={(e) => {
                const selectedAction = AVAILABLE_ACTIONS.find(a => a.id === e.target.value);
                updateNodeData({ 
                  actionType: e.target.value,
                  label: selectedAction?.label || "Action",
                  config: {}, // Reset config when changing action type
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

          {/* DYNAMIC FORM GENERATOR: Reads fields from registry.ts */}
          {selectedNode.data.actionType !== "unset" && (
            <div className="flex flex-col gap-4 border-t border-zinc-800 pt-4">
              <h3 className="text-xs font-semibold text-zinc-400 uppercase">Properties</h3>
              
              {AVAILABLE_ACTIONS.find(a => a.id === selectedNode.data.actionType)?.fields.map((field) => (
                <div key={field.name} className="flex flex-col gap-2">
                  <label className="text-xs text-zinc-300">
                    {field.label} {field.required && <span className="text-rose-500">*</span>}
                  </label>
                  
                  {/* Render based on field type defined in registry.ts */}
                  {field.type === 'string' && (
                    <input
                      type="text"
                      className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
                      value={selectedNode.data.config[field.name] || ""}
                      onChange={(e) => updateConfig(field.name, e.target.value)}
                    />
                  )}
                  
                  {field.type === 'textarea' && (
                    <textarea
                      rows={3}
                      className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500 resize-none"
                      value={selectedNode.data.config[field.name] || ""}
                      onChange={(e) => updateConfig(field.name, e.target.value)}
                    />
                  )}

                  {field.type === 'select' && (
                    <select
                      className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-blue-500"
                      value={selectedNode.data.config[field.name] || ""}
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
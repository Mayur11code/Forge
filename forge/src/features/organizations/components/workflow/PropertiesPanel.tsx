"use client";

import { useMemo, useRef, useState } from "react";
import {
  useReactFlow,
  useOnSelectionChange,
  useNodesData,
  useEdges,
  useNodes,
} from "@xyflow/react";
import { Braces, AlertTriangle, X, Trash2 } from "lucide-react";
import {
  AVAILABLE_ACTIONS,
  AVAILABLE_TRIGGERS,
  getDefaultConfigForAction,
  validateActionNodeConfig,
} from "@/lib/workflow-types/registry";
import {
  getAvailableUpstreamOutputs,
  getNodeDefinition,
  autoMapNodeVariables,
  type UpstreamOutputOption,
} from "@/lib/workflow/graph-ui/utils";
import type {
  TriggerNodeData,
  ActionNodeData,
  AppEdge,
  AppNode,
} from "@/lib/workflow-types/workflow";

type LiveNodeMatch =
  | { id: string; type: "trigger"; data: TriggerNodeData }
  | { id: string; type: "action"; data: ActionNodeData };

export interface PropertiesPanelProps {
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string | null) => void;
  onClose?: () => void;
  onUpdateNodeData?: (nodeId: string, patch: Partial<AppNode["data"]>) => void;
  onDeleteNode?: (nodeId: string) => void;
}

export default function PropertiesPanel({
  selectedNodeId: propSelectedNodeId,
  onSelectNode,
  onClose,
  onUpdateNodeData,
  onDeleteNode,
}: PropertiesPanelProps = {}) {
  const { updateNodeData, getNodes, setNodes } = useReactFlow<AppNode, AppEdge>();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [openPickerField, setOpenPickerField] = useState<string | null>(null);
  const inputRefs = useRef<Record<string, HTMLInputElement | HTMLTextAreaElement | null>>({});

  useOnSelectionChange({
    onChange: ({ nodes }) => {
      setSelectedNodeId(nodes.length > 0 ? nodes[0].id : null);
      if (nodes.length > 0 && onSelectNode) {
        onSelectNode(nodes[0].id);
      }
      setOpenPickerField(null);
    },
  });

  const liveNodes = useNodes() as AppNode[];
  const edges = useEdges() as AppEdge[];

  // Also read selected directly from liveNodes if selectedNodeId isn't set yet
  const selectedFromNodes = liveNodes.find((n) => n.selected)?.id ?? null;
  const activeNodeId =
    (propSelectedNodeId !== undefined ? propSelectedNodeId : selectedNodeId) ||
    selectedFromNodes;

  const nodeDataFromHook = useNodesData(activeNodeId!) as LiveNodeMatch | undefined;
  const nodeMatch: LiveNodeMatch | undefined =
    (liveNodes.find((n) => n.id === activeNodeId) as LiveNodeMatch | undefined) ||
    nodeDataFromHook;

  const upstreamOutputs = useMemo(() => {
    if (!activeNodeId || !nodeMatch || nodeMatch.type !== "action") return [];
    const currentNodes = liveNodes.length > 0 ? liveNodes : getNodes();
    return getAvailableUpstreamOutputs(activeNodeId, currentNodes, edges);
  }, [activeNodeId, nodeMatch, liveNodes, getNodes, edges]);

  const selectedActionDef = useMemo(() => {
    if (!nodeMatch || nodeMatch.type !== "action") return undefined;
    return AVAILABLE_ACTIONS.find((a) => a.id === nodeMatch.data.actionType);
  }, [nodeMatch]);

  const { missingVariables, ambiguousRequiredKeys, fieldErrors } = useMemo(() => {
    if (!nodeMatch || nodeMatch.type !== "action") {
      return {
        missingVariables: [] as string[],
        ambiguousRequiredKeys: [] as string[],
        fieldErrors: new Map<string, string>(),
      };
    }

    const actionDef = getNodeDefinition(nodeMatch);
    const availableKeys = upstreamOutputs.map((out) => out.outputKey);
    const missing = actionDef?.requires
      ? actionDef.requires.filter((req) => {
          const val = nodeMatch.data.config?.[req];
          const isProvided =
            val !== undefined &&
            val !== null &&
            (typeof val !== "string" || val.trim() !== "");
          if (isProvided) return false;

          // If req is 'title', also treat node label as fulfilling the title
          if (req === "title") {
            const configRecord = nodeMatch.data.config as Record<string, unknown> | undefined;
            const configTitle = typeof configRecord?.title === "string" ? configRecord.title : undefined;
            const labelVal = nodeMatch.data.label || configTitle;
            if (
              labelVal &&
              labelVal.trim() !== "" &&
              labelVal !== "Action" &&
              labelVal !== "New Action" &&
              labelVal !== "Select Action..." &&
              labelVal !== "Create a Task"
            ) {
              return false;
            }
          }

          return !availableKeys.includes(req);
        })
      : [];

    const ambiguous: string[] = [];
    if (actionDef?.requires) {
      for (const req of actionDef.requires) {
        const count = upstreamOutputs.filter((o) => o.outputKey === req).length;
        if (count > 1) ambiguous.push(req);
      }
    }

    const issues =
      nodeMatch.data.actionType && nodeMatch.data.actionType !== "unset"
        ? validateActionNodeConfig(
            nodeMatch.data.actionType,
            nodeMatch.data.config,
            upstreamOutputs,
          )
        : [];

    const errMap = new Map<string, string>();
    for (const issue of issues) {
      if (!errMap.has(issue.field)) {
        errMap.set(issue.field, issue.message);
      }
    }

    return {
      missingVariables: missing,
      ambiguousRequiredKeys: ambiguous,
      fieldErrors: errMap,
    };
  }, [nodeMatch, upstreamOutputs]);

  // When no node is selected, drawer does not occupy permanent horizontal canvas space
  if (!activeNodeId || !nodeMatch) {
    return null;
  }

  const handleCloseDrawer = () => {
    setSelectedNodeId(null);
    onSelectNode?.(null);
    onClose?.();
    setNodes((nds) => nds.map((n) => ({ ...n, selected: false })));
  };

  const handleDelete = () => {
    if (!activeNodeId) return;
    if (onDeleteNode) {
      onDeleteNode(activeNodeId);
    } else {
      setNodes((nds) => nds.filter((n) => n.id !== activeNodeId));
      handleCloseDrawer();
    }
  };

  const updateConfig = (key: string, value: unknown) => {
    if (nodeMatch.type !== "action") return;
    const currentConfig = nodeMatch.data.config || {};
    const nextConfig = { ...currentConfig, [key]: value };
    const patch: Partial<ActionNodeData> = {
      config: nextConfig,
      isConfigured: true,
    };

    // If key is "title", also update the node's visible display label on the canvas!
    if (key === "title" && typeof value === "string" && value.trim() !== "") {
      patch.label = value.trim();
    }

    updateNodeData(activeNodeId, patch);
    onUpdateNodeData?.(activeNodeId, patch);
  };

  const insertVariableIntoField = (
    fieldName: string,
    fieldType: string,
    option: UpstreamOutputOption,
    mode: "insert" | "replace",
  ) => {
    if (nodeMatch.type !== "action") return;
    const currentVal = nodeMatch.data.config?.[fieldName];
    const currentStr = currentVal == null ? "" : String(currentVal);

    if (mode === "replace" || (fieldType !== "string" && fieldType !== "textarea")) {
      updateConfig(fieldName, option.expression);
      setOpenPickerField(null);
      return;
    }

    const el = inputRefs.current[fieldName];
    if (el && typeof el.selectionStart === "number" && typeof el.selectionEnd === "number") {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const nextStr =
        currentStr.slice(0, start) + option.expression + currentStr.slice(end);
      updateConfig(fieldName, nextStr);
    } else {
      updateConfig(fieldName, currentStr + option.expression);
    }
    setOpenPickerField(null);
  };

  return (
    <aside className="w-96 h-full border-l border-white/[0.08] bg-[#0c0c14]/98 backdrop-blur-2xl p-5 flex flex-col gap-6 overflow-y-auto custom-scrollbar shrink-0 z-30 shadow-[-12px_0_35px_rgba(0,0,0,0.7)] animate-in slide-in-from-right duration-200">
      {/* HEADER */}
      <div className="space-y-1.5 border-b border-white/[0.08] pb-4">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono tracking-widest text-zinc-400 font-bold uppercase">
            [ NODE INSPECTOR ]
          </span>
          <div className="flex items-center gap-1.5">
            <span
              className={`text-[9px] font-mono font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                nodeMatch.type === "trigger"
                  ? "bg-amber-500/10 border border-amber-500/25 text-amber-300"
                  : "bg-indigo-500/10 border border-indigo-500/25 text-indigo-300"
              }`}
            >
              {nodeMatch.type === "trigger" ? "[ TRIGGER ]" : "[ ACTION ]"}
            </span>
            <button
              type="button"
              onClick={handleDelete}
              aria-label="Delete selected node"
              className="inline-flex items-center gap-1 rounded border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-mono font-medium text-rose-300 hover:bg-rose-500/20 hover:border-rose-500/50 transition-colors"
              title="Delete this node from workflow"
            >
              <Trash2 size={11} />
              <span>Delete</span>
            </button>
            <button
              type="button"
              onClick={handleCloseDrawer}
              aria-label="Close configuration drawer"
              className="h-6 w-6 rounded border border-white/[0.1] bg-white/[0.04] flex items-center justify-center text-zinc-400 hover:text-white hover:bg-white/[0.08] transition-colors"
              title="Close drawer"
            >
              <X size={13} />
            </button>
          </div>
        </div>
        <h2 className="text-sm font-bold text-zinc-100 uppercase tracking-wider">
          {nodeMatch.type === "trigger" ? "Trigger" : "Action"} Configuration
        </h2>
        <p className="text-[10px] text-zinc-400 font-mono bg-black/60 border border-white/[0.08] p-1.5 rounded-lg break-all">
          ID: {activeNodeId}
        </p>
      </div>

      {/* NODE TITLE / LABEL INPUT */}
      <div className="flex flex-col gap-1.5 border-b border-white/[0.08] pb-4">
        <label className="text-xs font-mono font-semibold tracking-wide text-zinc-300">
          Node Title / Step Name
        </label>
        <input
          type="text"
          aria-label="Node Title"
          className="w-full rounded-xl border border-white/[0.12] bg-black/70 px-3 py-2 text-xs font-mono text-zinc-100 placeholder:text-zinc-600 outline-none focus:border-white/40 focus:ring-1 focus:ring-white/20 transition-all shadow-inner"
          value={nodeMatch.data.label || ""}
          onChange={(e) => {
            const nextLabel = e.target.value;
            const currentConfig = nodeMatch.type === "action" ? nodeMatch.data.config || {} : {};
            const patch: Partial<ActionNodeData> = {
              label: nextLabel,
            };
            // If action, keep title config in sync in real time
            if (nodeMatch.type === "action") {
              patch.config = { ...currentConfig, title: nextLabel };
            }
            updateNodeData(activeNodeId, patch);
            onUpdateNodeData?.(activeNodeId, patch);
          }}
          placeholder="e.g. Create Automated Task"
        />
      </div>

      {/* --- TRIGGER UI --- */}
      {nodeMatch.type === "trigger" && (
        <div className="flex flex-col gap-2">
          <label className="text-xs font-mono font-semibold tracking-wide text-zinc-300">
            Event Type
          </label>
          <select
            aria-label="Trigger Event Type"
            className="w-full rounded-xl border border-white/[0.12] bg-black/70 px-3 py-2 text-xs font-mono text-zinc-100 outline-none focus:border-white/40 focus:ring-1 focus:ring-white/20 transition-all cursor-pointer shadow-inner"
            value={nodeMatch.data.eventId || ""}
            onChange={(e) => {
              const selectedTrigger = AVAILABLE_TRIGGERS.find(
                (t) => t.id === e.target.value,
              );
              const patch = {
                eventId: e.target.value,
                label: selectedTrigger?.label || "Trigger",
              };
              updateNodeData(activeNodeId, patch);
              onUpdateNodeData?.(activeNodeId, patch);

              getNodes().forEach((n) => {
                if (n.type === "action") {
                  autoMapNodeVariables(n.id, edges, setNodes);
                }
              });
            }}
          >
            <option value="" disabled>
              Select an event...
            </option>
            {AVAILABLE_TRIGGERS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
          {nodeMatch.data.eventId && (
            <p className="text-[11px] font-mono text-zinc-500 leading-relaxed">
              {AVAILABLE_TRIGGERS.find((t) => t.id === nodeMatch.data.eventId)?.description}
            </p>
          )}
        </div>
      )}

      {/* --- ACTION UI --- */}
      {nodeMatch.type === "action" && (
        <div className="flex flex-col gap-5">
          {/* ACTION TYPE DROPDOWN */}
          <div className="flex flex-col gap-2">
            <label className="text-xs font-mono font-semibold tracking-wide text-zinc-300">
              Action Type
            </label>
            <select
              aria-label="Action Type"
              className="w-full rounded-xl border border-white/[0.12] bg-black/70 px-3 py-2 text-xs font-mono text-zinc-100 outline-none focus:border-white/40 focus:ring-1 focus:ring-white/20 transition-all cursor-pointer shadow-inner"
              value={nodeMatch.data.actionType || "unset"}
              onChange={(e) => {
                const nextActionId = e.target.value;
                const selectedAction = AVAILABLE_ACTIONS.find(
                  (a) => a.id === nextActionId,
                );
                const defaults = getDefaultConfigForAction(nextActionId);
                const patch = {
                  actionType: nextActionId,
                  label: selectedAction?.label || "Action",
                  config: defaults,
                  isConfigured: false,
                };

                updateNodeData(activeNodeId, patch);
                onUpdateNodeData?.(activeNodeId, patch);

                autoMapNodeVariables(activeNodeId, edges, setNodes);
              }}
            >
              <option value="unset" disabled>
                Select an action...
              </option>
              {AVAILABLE_ACTIONS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
            {selectedActionDef?.description && (
              <p className="text-[11px] font-mono text-zinc-500 leading-relaxed">
                {selectedActionDef.description}
              </p>
            )}
          </div>

          {/* MISSING / AMBIGUOUS UPSTREAM ALERTS */}
          {missingVariables.length > 0 && (
            <div className="rounded-xl border border-rose-500/30 bg-rose-500/[0.08] p-3.5 backdrop-blur-md shadow-lg">
              <div className="flex items-center gap-2 mb-1.5">
                <div className="h-1.5 w-1.5 rounded-full bg-rose-500 animate-pulse" />
                <p className="text-[10px] font-mono font-bold uppercase tracking-widest text-rose-400">
                  Missing Upstream Data
                </p>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed mb-2 font-mono">
                Connect an upstream node or enter literal values for:
              </p>
              <div className="flex flex-wrap gap-1">
                {missingVariables.map((v) => (
                  <span
                    key={v}
                    className="rounded-md bg-rose-950/40 border border-rose-500/30 px-2 py-0.5 font-mono text-[9px] text-rose-300"
                  >
                    {v}
                  </span>
                ))}
              </div>
            </div>
          )}

          {ambiguousRequiredKeys.length > 0 && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/[0.08] p-3.5 backdrop-blur-md shadow-lg">
              <p className="text-[10px] font-mono font-bold uppercase tracking-widest text-amber-400 mb-1">
                Ambiguous Upstream Outputs
              </p>
              <p className="text-[11px] font-mono text-zinc-400 leading-relaxed">
                Multiple upstream nodes provide{" "}
                <span className="font-mono text-amber-300 font-semibold">
                  {ambiguousRequiredKeys.join(", ")}
                </span>
                . Use the variable picker below to choose the intended source.
              </p>
            </div>
          )}

          {/* SCHEMA-DRIVEN PROPERTIES FORM */}
          {selectedActionDef && (
            <div className="flex flex-col gap-4 border-t border-white/[0.08] pt-5">
              <h3 className="text-[10px] font-mono font-bold text-zinc-400 uppercase tracking-widest">
                [ PROPERTIES ]
              </h3>

              {selectedActionDef.fields.map((field) => {
                const rawValue = nodeMatch.data.config?.[field.name];
                const fieldError = fieldErrors.get(field.name);
                const isVarExpr =
                  typeof rawValue === "string" && /\{\{([\w.-]+)\}\}/.test(rawValue);

                return (
                  <div key={field.name} className="flex flex-col gap-1.5 relative">
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[11px] text-zinc-200 font-mono font-medium flex items-center gap-1.5">
                        <span>{field.label}</span>
                        {field.required ? (
                          <span className="text-zinc-400 text-[10px]" title="Required">
                            *
                          </span>
                        ) : (
                          <span className="text-[9px] font-mono text-zinc-500">
                            Optional
                          </span>
                        )}
                      </label>

                      {field.type !== "unsupported" &&
                        field.type !== "boolean" &&
                        upstreamOutputs.length > 0 && (
                          <button
                            type="button"
                            onClick={() =>
                              setOpenPickerField(
                                openPickerField === field.name ? null : field.name,
                              )
                            }
                            aria-label={`Insert variable for ${field.label}`}
                            className="inline-flex items-center gap-1 rounded-md border border-white/[0.15] bg-white/[0.04] px-2 py-0.5 text-[10px] font-mono text-zinc-300 hover:border-white/40 hover:text-white hover:bg-white/[0.08] transition-all shadow-sm"
                          >
                            <Braces className="h-2.5 w-2.5" />
                            <span>Var</span>
                          </button>
                        )}
                    </div>

                    {/* VARIABLE PICKER POPOVER */}
                    {openPickerField === field.name && (
                      <div className="rounded-xl border border-white/[0.15] bg-[#0c0c14]/98 p-3 shadow-[0_20px_45px_rgba(0,0,0,0.95)] backdrop-blur-2xl space-y-2 z-30">
                        <div className="flex items-center justify-between px-1 pb-1.5 border-b border-white/[0.08]">
                          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-zinc-400">
                            [ UPSTREAM OUTPUTS ]
                          </span>
                          <button
                            type="button"
                            onClick={() => setOpenPickerField(null)}
                            className="text-[10px] font-mono text-zinc-500 hover:text-zinc-200 transition-colors"
                          >
                            Close
                          </button>
                        </div>
                        <div className="max-h-44 overflow-y-auto space-y-1 pr-0.5">
                          {upstreamOutputs.map((opt) => (
                            <div
                              key={`${opt.sourceNodeId}.${opt.outputKey}`}
                              className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.04] bg-white/[0.02] p-2 hover:bg-white/[0.06] hover:border-white/[0.12] transition-all text-xs"
                            >
                              <div className="min-w-0">
                                <p className="text-[11px] font-mono font-semibold text-zinc-200 truncate">
                                  {opt.outputKey}
                                </p>
                                <p className="text-[9px] font-mono text-zinc-500 truncate">
                                  {opt.sourceNodeLabel} · {opt.expression}
                                </p>
                              </div>
                              <div className="flex items-center gap-1.5 shrink-0">
                                {(field.type === "string" || field.type === "textarea") && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      insertVariableIntoField(
                                        field.name,
                                        field.type,
                                        opt,
                                        "insert",
                                      )
                                    }
                                    className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[10px] font-mono font-semibold text-zinc-300 hover:bg-white/[0.08] hover:text-white transition-all"
                                  >
                                    Insert
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() =>
                                    insertVariableIntoField(
                                      field.name,
                                      field.type,
                                      opt,
                                      "replace",
                                    )
                                  }
                                  className="rounded-md border border-white/20 bg-white/[0.08] px-2 py-0.5 text-[10px] font-mono font-semibold text-zinc-200 hover:bg-white/[0.15] hover:text-white transition-all"
                                >
                                  Use
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* FIELD WIDGETS */}
                    {field.type === "string" && (
                      <div className="space-y-1.5">
                        <input
                          ref={(el) => {
                            inputRefs.current[field.name] = el;
                          }}
                          type="text"
                          aria-label={field.label}
                          className={`w-full rounded-xl border bg-black/70 px-3 py-2 text-xs font-mono text-zinc-100 placeholder:text-zinc-600 outline-none transition-all shadow-inner ${
                            fieldError
                              ? "border-rose-500/70 focus:border-rose-400 focus:ring-1 focus:ring-rose-500/30"
                              : "border-white/[0.12] focus:border-white/40 focus:ring-1 focus:ring-white/20"
                          }`}
                          value={rawValue == null ? "" : String(rawValue)}
                          onChange={(e) => updateConfig(field.name, e.target.value)}
                          placeholder={`Enter ${field.label.toLowerCase()}...`}
                        />
                        {field.name === "projectId" && (
                          <div className="flex flex-wrap gap-1.5 pt-0.5">
                            {upstreamOutputs.some((o) => o.outputKey === "projectId") && (
                              <button
                                type="button"
                                onClick={() => updateConfig("projectId", "{{trigger.outputs.projectId}}")}
                                className="text-[10px] font-mono px-2 py-0.5 rounded border border-white/20 bg-white/[0.08] text-zinc-200 hover:text-white hover:bg-white/[0.16] transition-colors"
                              >
                                + Map from Trigger
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => updateConfig("projectId", "clxyz0000000000000000000a")}
                              className="text-[10px] font-mono px-2 py-0.5 rounded border border-white/10 bg-black/40 text-zinc-400 hover:text-zinc-200 transition-colors"
                            >
                              Use Default Project
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    {field.type === "textarea" && (
                      <textarea
                        ref={(el) => {
                          inputRefs.current[field.name] = el;
                        }}
                        rows={3}
                        aria-label={field.label}
                        className={`w-full rounded-xl border bg-black/70 px-3 py-2 text-xs font-mono text-zinc-100 placeholder:text-zinc-600 outline-none resize-none transition-all shadow-inner ${
                          fieldError
                            ? "border-rose-500/70 focus:border-rose-400 focus:ring-1 focus:ring-rose-500/30"
                            : "border-white/[0.12] focus:border-white/40 focus:ring-1 focus:ring-white/20"
                        }`}
                        value={rawValue == null ? "" : String(rawValue)}
                        onChange={(e) => updateConfig(field.name, e.target.value)}
                        placeholder={`Enter ${field.label.toLowerCase()}...`}
                      />
                    )}

                    {field.type === "number" && (
                      <input
                        type={isVarExpr ? "text" : "number"}
                        aria-label={field.label}
                        className={`w-full rounded-xl border bg-black/70 px-3 py-2 text-xs font-mono text-zinc-100 placeholder:text-zinc-600 outline-none transition-all shadow-inner ${
                          fieldError
                            ? "border-rose-500/70 focus:border-rose-400 focus:ring-1 focus:ring-rose-500/30"
                            : "border-white/[0.12] focus:border-white/40 focus:ring-1 focus:ring-white/20"
                        }`}
                        value={rawValue == null ? "" : String(rawValue)}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v === "") {
                            updateConfig(field.name, undefined);
                          } else if (/\{\{/.test(v)) {
                            updateConfig(field.name, v);
                          } else {
                            const num = Number(v);
                            updateConfig(field.name, Number.isNaN(num) ? v : num);
                          }
                        }}
                        placeholder={`Enter ${field.label.toLowerCase()}...`}
                      />
                    )}

                    {field.type === "boolean" && (
                      <label className="inline-flex items-center gap-2 text-xs font-mono text-zinc-300 cursor-pointer">
                        <input
                          type="checkbox"
                          aria-label={field.label}
                          checked={Boolean(rawValue)}
                          onChange={(e) => updateConfig(field.name, e.target.checked)}
                          className="h-4 w-4 rounded border-white/[0.15] bg-black text-white focus:ring-0"
                        />
                        <span>{Boolean(rawValue) ? "Enabled" : "Disabled"}</span>
                      </label>
                    )}

                    {field.type === "select" &&
                      (isVarExpr ? (
                        <div className="flex items-center gap-1.5">
                          <input
                            type="text"
                            aria-label={field.label}
                            value={String(rawValue)}
                            onChange={(e) => updateConfig(field.name, e.target.value)}
                            className="w-full rounded-xl border border-white/30 bg-black/70 px-3 py-2 text-xs font-mono text-zinc-200 outline-none"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              updateConfig(field.name, field.defaultValue ?? "")
                            }
                            className="rounded-lg border border-white/[0.12] bg-white/[0.04] px-2.5 py-2 text-[10px] font-mono text-zinc-400 hover:text-white hover:border-white/30 transition-all"
                          >
                            Reset
                          </button>
                        </div>
                      ) : (
                        <select
                          aria-label={field.label}
                          className={`w-full rounded-xl border bg-black/70 px-3 py-2 text-xs font-mono text-zinc-100 outline-none transition-all cursor-pointer shadow-inner ${
                            fieldError
                              ? "border-rose-500/70 focus:border-rose-400 focus:ring-1 focus:ring-rose-500/30"
                              : "border-white/[0.12] focus:border-white/40 focus:ring-1 focus:ring-white/20"
                          }`}
                          value={rawValue == null ? "" : String(rawValue)}
                          onChange={(e) => updateConfig(field.name, e.target.value)}
                        >
                          <option value="" disabled>
                            Select option...
                          </option>
                          {field.options?.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      ))}

                    {field.type === "unsupported" && (
                      <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] font-mono text-amber-300 flex items-start gap-2 shadow-sm">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                        <span>
                          {field.unsupportedReason ||
                            "Unsupported field schema shape."}
                        </span>
                      </div>
                    )}

                    {field.description && (
                      <p className="text-[10px] font-mono text-zinc-500 leading-snug">
                        {field.description}
                      </p>
                    )}

                    {fieldError && (
                      <p className="text-[11px] font-mono text-rose-400 font-medium flex items-center gap-1">
                        <span>⚠</span> {fieldError}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </aside>
  );
}

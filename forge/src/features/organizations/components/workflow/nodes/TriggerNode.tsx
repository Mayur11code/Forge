import { Handle, Position, type NodeProps, useStore, useReactFlow } from '@xyflow/react';
import { Zap, AlertCircle, AlertTriangle, Trash2 } from 'lucide-react'; 
import type { AppEdge, AppNode, TriggerNodeType } from '@/lib/workflow-types/workflow';
import { getNodeDefinition } from '@/lib/workflow/graph-ui/utils';
import { evaluateWorkflowDiagnostics } from '@/lib/workflow/validation/diagnostics';

export default function TriggerNode({ id, data, selected, isConnectable }: NodeProps<TriggerNodeType>) {
  const { deleteElements } = useReactFlow();
  const nodes = useStore((s) => s.nodes) as AppNode[];
  const edges = useStore((s) => s.edges) as AppEdge[];
  const diagnostics = evaluateWorkflowDiagnostics(nodes, edges);
  const nodeIssues = diagnostics.issues.filter((i) => i.nodeId === id);

  // A brand-new trigger without an eventId is simply awaiting setup, not a graph error!
  const isUnconfigured = !data.eventId;
  const graphErrors = nodeIssues.filter(
    (i) =>
      i.severity === 'ERROR' &&
      i.code !== 'UNCONFIGURED_TRIGGER' &&
      i.code !== 'EMPTY_GRAPH',
  );
  const hasError = graphErrors.length > 0;
  const hasWarning = !hasError && nodeIssues.some((i) => i.severity === 'WARNING');

  // Landing page Kind 50 / Bizarro aerospace card styling
  const borderStyle = hasError
    ? 'border-rose-500/80 shadow-[0_0_25px_rgba(244,63,94,0.3),inset_0_1px_0_rgba(244,63,94,0.3)] ring-1 ring-rose-500/40'
    : hasWarning
    ? 'border-amber-500/80 shadow-[0_0_25px_rgba(245,158,11,0.25),inset_0_1px_0_rgba(245,158,11,0.2)] ring-1 ring-amber-500/40'
    : selected 
    ? 'border-white text-white shadow-[0_0_30px_rgba(245,158,11,0.25),inset_0_1px_0_rgba(255,255,255,0.4)] ring-1 ring-white/50' 
    : 'border-amber-500/25 hover:border-amber-500/40 shadow-[0_20px_45px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,255,255,0.18)]';

  // Fetch blueprint to see what variables this trigger outputs
  const definition = getNodeDefinition({ type: 'trigger', data });
  const outputs = definition?.outputs || [];

  return (
    <div className={`group cursor-pointer min-w-[260px] rounded-2xl bg-gradient-to-b from-[#181824]/95 to-[#0e0e15]/95 backdrop-blur-xl border transition-all duration-300 ${borderStyle}`}>
      
      {/* Node Header - Kind 50 orbital aesthetic with warm amber event tint */}
      <div className="flex items-center gap-3 rounded-t-2xl bg-amber-500/[0.07] border-b border-amber-500/20 px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/15 text-amber-300 shadow-[0_0_12px_rgba(245,158,11,0.15)]">
          <Zap size={16} fill="currentColor" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-amber-300 bg-amber-500/10 border border-amber-500/25 px-1 py-0.2 rounded">
                [ TRG ]
              </span>
              <h3 className="text-xs font-bold font-mono uppercase tracking-wider text-zinc-100">Trigger</h3>
            </div>
            <div className="flex items-center gap-1.5">
              {hasError && (
                <span
                  title={graphErrors[0]?.message}
                  className="inline-flex items-center gap-1 rounded bg-rose-500/20 border border-rose-500/40 px-1.5 py-0.5 text-[9px] font-mono font-bold text-rose-300 shadow-[0_0_10px_rgba(244,63,94,0.2)]"
                >
                  <AlertCircle size={10} />
                  Error
                </span>
              )}
              {!hasError && isUnconfigured && (
                <span
                  className="inline-flex items-center gap-1 rounded bg-white/[0.06] border border-white/[0.1] px-1.5 py-0.5 text-[9px] font-mono font-medium text-zinc-400"
                >
                  Needs Setup
                </span>
              )}
              {!hasError && !isUnconfigured && hasWarning && (
                <span
                  title={nodeIssues.find((i) => i.severity === 'WARNING')?.message}
                  className="inline-flex items-center gap-1 rounded bg-amber-500/20 border border-amber-500/40 px-1.5 py-0.5 text-[9px] font-mono font-bold text-amber-300 shadow-[0_0_10px_rgba(245,158,11,0.2)]"
                >
                  <AlertTriangle size={10} />
                  Warn
                </span>
              )}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  deleteElements({ nodes: [{ id }] });
                }}
                aria-label="Delete trigger"
                className="opacity-0 group-hover:opacity-100 p-0.5 text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 rounded transition-all"
                title="Delete trigger node"
              >
                <Trash2 size={12} />
              </button>
            </div>
          </div>
          <p className="text-xs text-amber-200/90 font-medium truncate mt-0.5">
            {data.label || 'Select an Event...'}
          </p>
        </div>
      </div>

      {/* Node Body */}
      <div className="px-4 py-3 rounded-b-2xl space-y-3">
        <div className="rounded-lg bg-black/50 border border-white/[0.06] px-2.5 py-1.5 font-mono text-[11px] text-zinc-400">
          {data.eventId ? `Event: ${data.eventId}` : 'Needs configuration'}
        </div>

        {/* Display Output Variables */}
        {outputs.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[9px] font-mono font-bold text-amber-400/80 uppercase tracking-widest">
              [ GENERATES DATA ]
            </p>
            <div className="flex flex-wrap gap-1">
              {outputs.map((variable) => (
                <span 
                  key={variable} 
                  className="text-[9px] px-1.5 py-0.5 rounded-md bg-amber-500/[0.08] border border-amber-500/20 text-amber-200 font-mono shadow-sm"
                >
                  {variable}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Sleek Dock Handle */}
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={isConnectable}
        className="!h-3 !w-3 !border-2 !border-[#07070a] !bg-amber-400 hover:!scale-125 transition-transform shadow-[0_0_8px_rgba(245,158,11,0.35)]" 
      />
    </div>
  );
}

import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Settings2, AlertCircle } from 'lucide-react';
import type { ActionNodeType } from '@/lib/workflow-types/workflow';

import { useMemo } from 'react'; // Add useMemo to existing 'react' import
import { useStore } from '@xyflow/react'; // Add useStore
import { getAvailableUpstreamOutputs, getNodeDefinition } from '@/lib/workflow/graph-ui/utils'; // Adjust path if needed
import { ActionDef } from '@/lib/workflow-types/registry';

export default function ActionNode({id, data, selected, isConnectable }: NodeProps<ActionNodeType>) {
  
// 1. Pull the global graph state
const nodes = useStore((s) => s.nodes);
const edges = useStore((s) => s.edges);

// 2. Identify what this action needs
const actionDef = getNodeDefinition({ type: 'action', data } as any) as ActionDef | undefined;

// 3. Scan for available variables
const upstreamOutputs = useMemo(() => 
  getAvailableUpstreamOutputs(id, nodes as any, edges as any), 
[id, nodes, edges]);

// 4. Calculate missing requirements
const missingVariables = useMemo(() => {
  if (!actionDef?.requires) return [];
  const availableKeys = upstreamOutputs.map((out) => out.outputKey);
  return actionDef.requires.filter((req) => !availableKeys.includes(req));
}, [actionDef, upstreamOutputs]);

// 5. UPDATE YOUR EXISTING STATE: A node is only "Ready" if it is configured AND has no graph errors
const hasGraphError = missingVariables.length > 0;
const isReady = data.isConfigured && !hasGraphError;

  const accentColor = isReady ? 'blue' : 'rose';
  
  const borderStyle = selected 
    ? `border-${accentColor}-500 shadow-[0_0_15px_rgba(var(--${accentColor}-500),0.2)]` 
    : isReady ? 'border-zinc-800' : 'border-rose-500/50';

  return (
    <div className={`min-w-[250px] rounded-xl bg-[#121212] border transition-all duration-200 ${borderStyle}`}>
      
      {/* Target Handle (Top) */}
      <Handle
        type="target"
        position={Position.Top}
        isConnectable={isConnectable}
        className={`h-3 w-3 border-2 border-[#121212] ${isReady ? 'bg-blue-500' : 'bg-rose-500'}`}
      />

      {/* Node Header */}
      <div className={`flex items-center gap-3 rounded-t-xl border-b px-4 py-3 
        ${isReady ? 'bg-blue-500/10 border-blue-500/20' : 'bg-rose-500/10 border-rose-500/20'}`}>
        <div className={`flex h-8 w-8 items-center justify-center rounded-lg 
          ${isReady ? 'bg-blue-500/20 text-blue-400' : 'bg-rose-500/20 text-rose-400'}`}>
          {isReady ? <Settings2 size={18} /> : <AlertCircle size={18} />}
        </div>
        <div>
          <h3 className="text-sm font-bold text-zinc-100">Action</h3>
          <p className={`text-xs font-medium opacity-80 ${isReady ? 'text-blue-400' : 'text-rose-400'}`}>
            {data.label || 'Select Action...'}
          </p>
        </div>
      </div>

    {/* Node Body */}
<div className="px-4 py-3 rounded-b-xl space-y-2">
  <p className="text-xs text-zinc-500">
    Type: <span className="font-mono text-zinc-300 bg-zinc-800/50 px-1 py-0.5 rounded">{data.actionType || 'Unset'}</span>
  </p>

  {/* ADD THIS: The Missing Variables List */}
  {hasGraphError && (
    <div className="mt-2 space-y-1">
      <p className="text-[10px] font-bold text-rose-400 uppercase tracking-tight">Missing Data:</p>
      <div className="flex flex-wrap gap-1">
        {missingVariables.map((v) => (
          <span key={v} className="text-[9px] px-1.5 py-0.5 rounded-md bg-rose-500/10 border border-rose-500/20 text-rose-300 font-mono">
            {v}
          </span>
        ))}
      </div>
    </div>
  )}
</div>

      {/* Source Handle (Bottom) */}
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={isConnectable}
        className={`h-3 w-3 border-2 border-[#121212] ${isReady ? 'bg-blue-500' : 'bg-rose-500'}`}
      />
    </div>
  );
}
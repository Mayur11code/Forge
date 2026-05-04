import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Zap } from 'lucide-react'; 
import type { TriggerNodeType } from '@/lib/workflow-types/workflow';
import { getNodeDefinition } from '@/lib/workflow/graph-ui/utils';

export default function TriggerNode({ data, selected, isConnectable }: NodeProps<TriggerNodeType>) {
  // Sleek selection glow
  const borderStyle = selected 
    ? 'border-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.2)]' 
    : 'border-zinc-800 hover:border-zinc-700';

// 2. Fetch the blueprint to see what variables this trigger outputs
  const definition = getNodeDefinition({ type: 'trigger', data } as any);
  const outputs = definition?.outputs || [];

  return (
    <div className={`min-w-[250px] rounded-xl bg-[#121212] border transition-all duration-200 ${borderStyle}`}>
      
      {/* Node Header - Sleek Glassy Green */}
      <div className="flex items-center gap-3 rounded-t-xl bg-emerald-500/10 border-b border-emerald-500/20 px-4 py-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/20 text-emerald-400">
          <Zap size={18} fill="currentColor" />
        </div>
        <div>
          <h3 className="text-sm font-bold text-zinc-100">Trigger</h3>
          <p className="text-xs text-emerald-400/80 font-medium">
            {data.label || 'Select an Event...'}
          </p>
        </div>
      </div>

      {/* Node Body */}
<div className="px-4 py-3 rounded-b-xl space-y-3">
  <p className="text-xs text-zinc-500">
    {data.eventId ? `Event: ${data.eventId}` : 'Needs configuration'}
  </p>

  {/* NEW: Display the Output Variables */}
  {outputs.length > 0 && (
    <div className="space-y-1.5">
      <p className="text-[10px] font-bold text-emerald-400 uppercase tracking-tight">Generates Data:</p>
      <div className="flex flex-wrap gap-1">
        {outputs.map((variable) => (
          <span 
            key={variable} 
            className="text-[9px] px-1.5 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 font-mono"
          >
            {variable}
          </span>
        ))}
      </div>
    </div>
  )}
</div>
      {/* Sleek Dark Handle */}
      <Handle
        type="source"
        position={Position.Bottom}
        isConnectable={isConnectable}
        className="h-3 w-3 border-2 border-[#121212] bg-emerald-500" 
      />
    </div>
  );
}
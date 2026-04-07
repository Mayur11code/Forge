import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Zap } from 'lucide-react'; 
import type { TriggerNodeType } from '@/lib/workflow-types/workflow';

export default function TriggerNode({ data, selected, isConnectable }: NodeProps<TriggerNodeType>) {
  // Sleek selection glow
  const borderStyle = selected 
    ? 'border-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.2)]' 
    : 'border-zinc-800 hover:border-zinc-700';

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
      <div className="px-4 py-3 rounded-b-xl">
        <p className="text-xs text-zinc-500">
          {data.eventId ? `Listening for: ${data.eventId}` : 'Needs configuration'}
        </p>
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
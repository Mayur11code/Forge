import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Settings2, AlertCircle } from 'lucide-react';
import type { ActionNodeType } from '@/lib/workflow-types/workflow';

export default function ActionNode({ data, selected, isConnectable }: NodeProps<ActionNodeType>) {
  
  // Dynamic sleek styling based on configuration state
  const isReady = data.isConfigured;
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
      <div className="px-4 py-3 rounded-b-xl">
        <p className="text-xs text-zinc-500">
          Type: <span className="font-mono text-zinc-300 bg-zinc-800/50 px-1 py-0.5 rounded">{data.actionType || 'Unset'}</span>
        </p>
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
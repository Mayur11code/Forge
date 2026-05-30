import { useEffect, useRef } from "react";
import { useReactFlow } from "@xyflow/react";

export function useWorkflowLiveStream(runId: string | undefined) {
  // 1. THE ZUSTAND/REACT-FLOW BINDING
  // We grab the setter directly from React Flow's internal store.
  const { setNodes } = useReactFlow();
  
  // 2. THE STRICT MODE GUARD
  // React 18 mounts useEffect twice in development. This ref ensures 
  // we only ever open ONE physical connection to your SSE route.
  const isConnected = useRef(false);

  useEffect(() => {
    if (!runId || isConnected.current) return;

    // 3. THE CONNECTION
    const eventSource = new EventSource(`/api/workflow/${runId}/stream`);
    isConnected.current = true;

    // 4. THE EVENT HANDLER
    eventSource.onmessage = (event) => {
      // The heartbeat sends ": heartbeat", which native EventSource ignores,
      // but just in case we get empty data, we safely skip it.
      if (!event.data) return;

      try {
        const data = JSON.parse(event.data);
        
        if (data.type === "STEP_STATE_CHANGE") {
          console.log(`[SSE] Node ${data.stepId} changed to ${data.status}`);
          
          // 5. THE FUNCTIONAL UPDATER (Avoiding Stale Closures)
          // We MUST use the `nds => ...` pattern. If we just used the `nodes` 
          // array from context, the SSE closure would trap an old version of the graph.
          setNodes((nds) => 
            nds.map((node) => {
              if (node.id === data.stepId) {
                return {
                  ...node,
                  data: { 
                    ...node.data, 
                    // We inject the live status directly into the node's internal data
                    executionStatus: data.status 
                  }
                };
              }
              return node;
            })
          );
        }
      } catch (error) {
        console.error("[SSE] Failed to parse stream data:", error);
      }
    };

    // 6. ERROR HANDLING & AUTO-RECONNECT LOGIC
    eventSource.onerror = (err) => {
      console.warn("[SSE] Connection interrupted. Browser will auto-reconnect...", err);
      // EventSource natively attempts to reconnect. We don't need to manually
      // recreate the connection, but we can log it for observability.
    };

    // 7. THE GARBAGE COLLECTOR
    return () => {
      eventSource.close();
      isConnected.current = false;
    };
    
  }, [runId, setNodes]); 
}
import { useEffect } from "react";
import { getPusherClient } from "@/lib/pusher/pusher-client";

// NEW: Accept setNodes as a parameter
export function useWorkflowLiveStream(runId: string | undefined, setNodes: any) {
  useEffect(() => {
    // Failsafes
    if (!runId || !setNodes) return;
    
    const pusher = getPusherClient();
    if (!pusher) return; 

    const channelName = `private-workflow-${runId}`;
    const channel = pusher.subscribe(channelName);

    const handleStepChange = (data: { stepId: string, status: string }) => {
      console.log(`[PUSHER] Forcing React re-render for ${data.stepId} -> ${data.status}`);
      
       console.log("[PUSHER EVENT]", data);
      
      // Update the local component state directly!
      setNodes((nds: any[]) => 
        nds.map((node) => {
          if (node.id === data.stepId) {
            return {
              ...node,
              data: { ...node.data, executionStatus: data.status }
            };
          }
          return node;
        })
      );
    };

    channel.bind("STEP_STATE_CHANGE", handleStepChange);

    return () => {
      channel.unbind("STEP_STATE_CHANGE", handleStepChange);
      pusher.unsubscribe(channelName);
    };
  }, [runId, setNodes]);
}
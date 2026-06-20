// test-event.js
const testEmbedding = async () => {
  const DATA = {
    taskId: "cmqmct2v3000034gcgjvj61vp", 
    orgId: "0d74fb33-0386-4c63-8f96-c2bd1496c055",
    projectId: "cmnj8u44p0003a0gcvqgt25dv"
  };

  try {
    // FIX: Removed /route.ts from the end
    // Using localhost directly since we bypassed QStash signatures in dev mode
    const response = await fetch("http://localhost:3000/api/worker", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "TASK_UPDATED",
        data: DATA
      })
    });

    console.log("Response Status:", response.status);
    const body = await response.text();
    console.log("Response Body:", body);
  } catch (err) {
    console.error("Connection failed:", err.message ? err.message : "Unknown error");
  }
};

testEmbedding();
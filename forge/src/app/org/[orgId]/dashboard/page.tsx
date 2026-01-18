// src/app/org/[orgId]/dashboard/page.tsx

import { mockTasks } from "@/features/tasks/mockData";



export default async function DashboardPage({ 
  params 
}: { 
  params: Promise<{ orgId: string }> 
}) {
  // Awaiting params is mandatory in Next.js 15
  const { orgId } = await params;

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Dashboard Overview</h2>
      <p className="text-gray-600">
        Showing insights for organization: <span className="font-mono text-blue-600">{orgId}</span>
      </p>
      
      {/* Placeholder for later metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-4 border rounded shadow-sm bg-black">Total Tasks: {mockTasks.length}</div>
        <div className="p-4 border rounded shadow-sm bg-black">Active Members: {mockTasks.length}</div>
        <div className="p-4 border rounded shadow-sm bg-black">Events Logged: 0</div>
      </div>
    </div>
  );
}
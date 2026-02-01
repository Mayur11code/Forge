import { auth } from "@/lib/auth/auth"; // Import the heavy auth
import { mockTasks } from "@/features/tasks/mockData";
import TaskCard from "@/features/organizations/components/TaskCard";
import React from "react";
import TaskbBox from "@/features/organizations/components/TaskBox";

export default async function TasksPage({ 
  params 
}: { params: Promise<{ orgId: string }> }) {
    const { orgId } = await params;
    
    // 1. Fetch the session on the server
    const session = await auth();

    // 2. THE LOGIC TEST: This will print in your TERMINAL
    console.log("-----------------------------------------");
    console.log("🚀 SERVER LOG - TASKS PAGE");
    console.log("USER:", session?.user?.name);
    console.log("ROLE:", session?.user?.role);
    console.log("ORG ID:", orgId);
    console.log("-----------------------------------------");
   
    return (
        <div className="space-y-4">
            <h1 className="text-2xl font-bold">Organization: {orgId}</h1>
            <p className="text-gray-600">
                Logged in as: <span className="font-mono text-blue-500">{session?.user?.role}</span>
            </p>
            
            {/* Pass the role to your Client Component if it needs to hide/show buttons */}
            <TaskbBox param={{ orgId }} userRole={session?.user?.role} />
        </div>
    );
}
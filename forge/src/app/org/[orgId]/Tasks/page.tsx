'use client';
import { mockTasks } from "@/features/tasks/mockData";
import TaskCard from "@/features/organizations/components/TaskCard";
import React from "react";
import TaskbBox from "@/features/organizations/components/TaskBox";

export default async function TasksPage({ 
  params 
}: { params: Promise<{ orgId: string }> }) {
    const { orgId } = await params;
   
    return (
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Tasks for Organization: <span className="font-mono text-blue-600">{orgId}</span></h2>
          <p className="text-gray-600">This is where tasks related to the organization will be displayed.</p>
            <TaskbBox param={{ orgId }} />
        </div>
    )}

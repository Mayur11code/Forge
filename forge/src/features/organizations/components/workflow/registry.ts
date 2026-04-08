// src/lib/workflow/registry.ts

// 1. Core Types for our I/O System
export type FieldDef = {
  name: string;
  label: string;
  type: 'string' | 'select' | 'textarea' | 'number';
  options?: { label: string; value: string }[]; 
  required: boolean;
};

export type TriggerDef = {
  id: string;
  label: string;
  description: string;
  outputs: string[]; // Variables this trigger injects into the flow
};

export type ActionDef = {
  id: string;
  label: string;
  description: string;
  requires: string[]; // Variables this action MUST receive from upstream
  outputs: string[];  // Variables this action creates for downstream
  fields: FieldDef[]; // The UI form fields
};

// 2. The Triggers (Based on your Prisma Schema)
export const AVAILABLE_TRIGGERS: TriggerDef[] = [
  { 
    id: 'task.created', 
    label: 'On Task Created', 
    description: 'Triggers when a new task is added.',
    // When this event fires from your EventBus, it will provide these variables:
    outputs: ['taskId', 'projectId', 'assigneeId'] 
  },
  { 
    id: 'project.created', 
    label: 'On Project Created', 
    description: 'Triggers when a new project is initialized.',
    outputs: ['projectId'] 
  },
  { 
    id: 'user.joined', 
    label: 'On User Joined', 
    description: 'Triggers when an invitation is accepted.',
    outputs: ['userId', 'orgId', 'email'] 
  },
];

// 3. The Actions (Based on your Prisma Schema)
export const AVAILABLE_ACTIONS: ActionDef[] = [
  {
    id: 'task.create',
    label: 'Create a Task',
    description: 'Automatically generate a new task.',
    // Requires a projectId to exist somewhere upstream!
    requires: ['projectId'], 
    // Outputs the ID of the newly created task
    outputs: ['taskId'], 
    fields: [
      { name: 'title', label: 'Task Title', type: 'string', required: true },
      { 
        name: 'priority', 
        label: 'Priority', 
        type: 'select', 
        options: [
          { label: 'Low', value: 'LOW' },
          { label: 'Medium', value: 'MEDIUM' },
          { label: 'High', value: 'HIGH' }
        ],
        required: true 
      }
    ]
  },
  {
    id: 'comment.add',
    label: 'Add a Comment',
    description: 'Post an automated comment on a task.',
    // Requires BOTH a taskId (where to comment) and userId (who is commenting)
    requires: ['taskId', 'userId'], 
    outputs: ['commentId'],
    fields: [
      { name: 'content', label: 'Comment Body', type: 'textarea', required: true },
    ]
  }
];
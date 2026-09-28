import { tool } from "ai";

import { createTaskSchema } from "./schema";

export const createTaskTool = tool({
  description: [
    "CREATE a new task inside the user's organization.",
    "",
    "This is a WRITE operation: it permanently adds a task. Only call it when the",
    "user has explicitly asked you to create a task, add a task, or turn their",
    "request into a task. Never call it proactively, never call it to restate",
    "what you are about to do, and never call it for a message that was purely a",
    "question or a status update.",
    "",
    "The project is identified by name via `projectName`, which must match an",
    "existing project. If the name is wrong or ambiguous the tool returns the",
    "available project names so you can ask the user which one they meant.",
    "",
    "You never choose the organization. It is always derived from the user's",
    "session.",
    "",
    "Do not report the task as created until this tool returns ok: true.",
  ].join(" "),

  inputSchema: createTaskSchema,
});

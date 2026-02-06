import { version } from "typescript";   
import { z } from "zod";


const UserSchema = z.object({
    id: z.uuid({version: "v4"}), 
    email: z.string().email({message: "Invalid email address"}),
    role : z.enum(["admin", "owner", "guest"])
});




export const createTaskSchema = z.object({
  title: z
    .string()
    .min(3, "Task title must be at least 3 characters")
    .max(100, "Task title must be at most 100 characters"),

  projectId: z
    .string()
    .cuid("Invalid project ID"),

  // Optional for future extensibility
  assigneeId: z
    .string()
    .cuid("Invalid assignee ID")
    .optional(),

  priority: z
    .enum(["LOW", "MEDIUM", "HIGH"])
    .optional()
    .default("MEDIUM"),

});


export const updateTaskSchema = z.object({
  taskId: z.string().cuid("Invalid task ID"),

  title: z
    .string()
    .min(3)
    .max(100)
    .optional(),

  status: z
    .enum(["TODO", "IN_PROGRESS", "DONE"])
    .optional(),

  priority: z
    .enum(["LOW", "MEDIUM", "HIGH"])
    .optional(),

  assigneeId: z
    .string()
    .cuid()
    .nullable()
    .optional(),
});



export type Task = z.infer<typeof createTaskSchema>;
export type User = z.infer<typeof UserSchema>;
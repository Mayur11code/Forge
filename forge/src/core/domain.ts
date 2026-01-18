import { version } from "typescript";   
import { z } from "zod";


const UserSchema = z.object({
    id: z.uuid({version: "v4"}), 
    email: z.string().email({message: "Invalid email address"}),
    role : z.enum(["admin", "owner", "guest"])
});


const Tasks = z.object({ 
    id: z.uuid({version: "v4"}),
    title: z.string().min(5, {message: "Title must be at least 5 characters long"}),
    description: z.string().max(500, {message: "Description cannot exceed 500 characters"}).optional(),
    status: z.enum(["pending", "in-progress", "completed"]),
    dueDate: z.date().optional(),
    assignedTo: UserSchema.optional(),
    priority : z.enum(["low", "medium", "high"]).default("medium")
});

export type Task = z.infer<typeof Tasks>;
export type User = z.infer<typeof UserSchema>;
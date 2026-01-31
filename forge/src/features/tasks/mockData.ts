import  {Task} from "@/core/domain";


export const mockTasks: Task[] = [
    {
        id: "1e7b8f9e-3c4d-4f5a-9f1e-2b3c4d5e6f7g",
        title: "Design Homepage",
        description: "Create a modern and responsive design for the homepage.",
        status: "in-progress",
        dueDate: new Date("2024-07-15"),
        priority: "high"
    },
    {   
        id: "2f8c9d0e-4d5e-5f6b-0a1b-2c3d4e5f6g7h",
        title: "Implement Authentication",
        description: "Set up user authentication and authorization.",
        status: "pending",
        dueDate: new Date("2024-08-01"),
        priority: "medium"
    },
    {
        id: "3g9d0e1f-5f6b-6a7c-1b2c-3d4e5f6g7h8i",
        title: "Database Optimization",
        description: "Optimize database queries for better performance.",
        status: "completed",
        priority: "low"
    },
    {
        id: "4h0e1f2g-6a7c-7b8d-2c3d-4e5f6g7h8i9j",
        title: "Set Up CI/CD Pipeline",
        description: "Configure continuous integration and deployment pipeline.",
        status: "in-progress",
        dueDate: new Date("2024-07-20"),
        priority: "high"
    },
    {
        id: "5i1f2g3h-7b8d-8c9e-3d4e-5f6g7h8i9j0k",
        title: "Write Documentation",
        description: "Create comprehensive documentation for the project.",
        status: "pending",
        dueDate: new Date("2024-08-10"),
        priority: "medium"
    }  
];
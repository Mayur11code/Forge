// 'use client';

// import React, { startTransition } from "react";
// import SearchBox from "@/features/organizations/components/SearchBox";
// import { ListFilter, CheckCircle2, Clock, PlayCircle, Layers } from "lucide-react"; // Matching our icon style
// import { clsx } from "clsx";
// import { Task } from "@prisma/client";
// import { useOptimistic } from "react";
// import CreateTaskForm from "./CreateTaskForm";
// import { createTask } from "@/app/org/[orgId]/projects/[projectId]/action";

// type ProjectModeProps = {
//   mode: "project";
//   param: { orgId: string };
//   projectId: string;
//   initialtasks: Task[];
// };

// type OrgModeProps = {
//   mode: "org";
//   param: { orgId: string };
//   initialtasks: Task[];
// };

// type TaskBoxProps = ProjectModeProps | OrgModeProps;


// export default function TasksPage( props : TaskBoxProps) {
 
//  const isProjectMode = props.mode === "project";
// //check mode

 
//     // Logic remains exactly as requested
//     // State to manage the current filter
//     //passed to SearchBox for filtering logic
//     const [filter, setFilter] = React.useState<string>("ALL");
    
//     //optimistic UI state for tasks, allowing us to show the new task immediately upon creation without waiting for server response
//     const [optimisticTasks, updateOptimisticTasks] = useOptimistic(
//         props.initialtasks,
//         (state: Task[], action: { type: "add" | "replace"; task: Task; tempId?: string }) => {
//             if (action.type === "add") {
//                 // Add the new task to the state immediately, this is run before the server even knows anout the tasks lolll
//                 return [...state, action.task];
//             }

//             if (action.type === "replace") {
//                 // Replace the temp task with the one returned from the server (which has the real ID)
//                 //Warna puraana fake task hi dikhta rahega and server may crash if you try to edit that
//                 //BUT ACTUALLY HERE IT DOESN't MATTER SINCE THE SERVER ACTION HAS REVALIDATE PATH CALLED
//                 //which means the whole page will refresh with the correct data from the server anyway
//                 return state.map((t) =>
//                     t.id === action.tempId ? action.task : t
//                 );
//             }

//             return state;
//             //optimistic function also acts like a reducer that's why this logic can be placed here
//             //state is the current list of tasks, action describes what change we want to make (add or replace) 
//             // optimisticTasks = state
//         }
//     );


//     // Handler for adding a new task (optimistically)
//  async function handleAddTask(title: string) {
//   if (!isProjectMode) return;
//   //check the mode

//   const tempId = Math.random().toString();
// //fake id for optimistic task, this will be replaced by the real ID from the server once the task is created

//   const tempTask: Task = {
//     id: tempId,
//     title,
//     status: "TODO",
//     priority: "MEDIUM",
//     projectId: props.projectId,
//     assigneeId: null,
//     createdAt: new Date(),
//     updatedAt: new Date(),
//   };

//   //react strictly wants the optimisitic update to be wrapped in startTransition to avoid blocking the UI
//   //this allows us to show the new task immediately while the server is processing the creation in the background
//   //actually you need a startTransition when server actions are involved to prevent React from treating the UI update as high priority 
//   // and blocking user interactions until the server responds, which would defeat the purpose of optimistic updates
//   startTransition(async () => {
//     updateOptimisticTasks({ type: "add", task: tempTask });
// //this immediately adds the temp task to the UI, giving instant feedback to the user that their action was registered
//     try {
//       await createTask({
//         title,
//         projectId: props.projectId,
//       });

//       updateOptimisticTasks({ type: "replace", task: {
//           ...tempTask,
//           id: tempId, //keep the same id for replacement logic
//         }, tempId });
//  //once the server confirms the task creation, we replace the temp task with the real one from the server
//     } catch (e) {
//       console.error(e);
//     }
//   });
// }




//     // Helper for beautiful button styles
//     const filterOptions = [
//         { id: "ALL", label: "All Tasks", icon: Layers },
//         { id: "TODO", label: "Pending", icon: Clock },
//         { id: "IN_PROGRESS", label: "In-Progress", icon: PlayCircle },
//         { id: "DONE", label: "Completed", icon: CheckCircle2 },
//     ];

//     return (
//         <div className="space-y-8 animate-in fade-in duration-700">
//             {/* Header Section */}
//             <div className="flex flex-col gap-6">
//                 <div>
//                     <h2 className="text-2xl font-bold text-white tracking-tight">Tasks Management  : {props.param.orgId}</h2>
//                     <p className="text-zinc-400 text-sm mt-1">Manage and track your organization's progress.</p>
//                 </div>

//                 {/* Filter & Search Container */}
//                 <div className="p-6 rounded-2xl bg-zinc-900/40 border border-zinc-800/50 backdrop-blur-md shadow-xl">
//                     <div className="space-y-6">
//                         {/* Filter Segmented Control */}
//                         <div>
//                             <label className="flex items-center gap-2 mb-4 text-[11px] font-bold uppercase tracking-[0.2em] text-zinc-500">
//                                 <ListFilter className="w-3 h-3" />
//                                 Quick Filter
//                             </label>

//                             <div className="flex flex-wrap items-center gap-2 p-1.5 bg-zinc-950/50 rounded-xl border border-zinc-800/50 w-fit">
//                                 {filterOptions.map((opt) => {
//                                     const Icon = opt.icon;
//                                     const isActive = filter === opt.id;

//                                     return (
//                                         <button
//                                             key={opt.id}
//                                             onClick={() => setFilter(opt.id)}
//                                             className={clsx(
//                                                 "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all duration-200",
//                                                 isActive
//                                                     ? "bg-blue-600 text-white shadow-lg shadow-blue-900/20"
//                                                     : "text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50"
//                                             )}
//                                         >
//                                             <Icon className={clsx("w-4 h-4", isActive ? "text-white" : "text-zinc-500")} />
//                                             {opt.label}
//                                         </button>
//                                     );
//                                 })}
//                             </div>
//                         </div>

//                         {/* Search Component Divider */}
//                         <div className="h-px bg-zinc-800/50 w-full" />
//                         {isProjectMode && <CreateTaskForm onCreate={handleAddTask} />}


//                         {/* SearchBox - Pass the filter logic down as before */}
//                         <SearchBox filter={filter} initialtasks={optimisticTasks} />
//                     </div>
//                 </div>
//             </div>
//         </div>
//     );
// }
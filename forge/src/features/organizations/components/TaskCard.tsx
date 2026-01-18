import { Task } from "@/core/domain";

export default function TaskCard({ task }: { task : Task }) {

    return (
        <div className="border rounded shadow-sm p-4 mb-4 bg-black-50">
            <h3 className="text-lg font-semibold mb-2">{task.title}</h3>
            <p className="text-gray-500 mb-4">{task.description}</p>
            <div className="flex justify-between items-center">
                <span className="text-sm text-gray-400">Status: {task.status}</span>
                {task.dueDate && <span className="text-sm text-gray-400">Due: {new Date(task.dueDate).toLocaleDateString()}</span>}
            </div>
        </div>
    );
}
'use client';

export default function ProjectError() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-4">Error Loading Project</h1>
      <p className="text-gray-600">
        There was an error loading the project. Please try again later.
      </p>
    </div>
  );
}
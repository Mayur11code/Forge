// src/app/dashboard/loading.tsx
export default function Loading() {
  return (
    <div className="h-screen flex items-center justify-center">
      <div className="animate-spin h-8 w-8 border-4 border-primary rounded-full border-t-transparent"></div>
    </div>
  );
}
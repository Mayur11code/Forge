export default function RecentSkeleton() {
  return (
    <div className="rounded-3xl border border-zinc-800/50 bg-zinc-900/20 p-8 animate-pulse space-y-4">
      <div className="h-6 w-48 bg-zinc-800 rounded mb-6" />
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="h-4 bg-zinc-800 rounded" />
      ))}
    </div>
  );
}

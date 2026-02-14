export default function StatsSkeleton() {
  return (
    <div className="grid grid-cols-4 gap-6 animate-pulse">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="h-32 bg-zinc-900/40 border border-zinc-800/50 rounded-2xl"
        />
      ))}
    </div>
  );
}

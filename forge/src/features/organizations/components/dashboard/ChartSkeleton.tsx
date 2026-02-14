export default function ChartSkeleton() {
  return (
    <div className="rounded-3xl border border-zinc-800/50 bg-zinc-900/20 p-8 animate-pulse">
      <div className="h-6 w-48 bg-zinc-800 rounded mb-6" />
      <div className="h-48 bg-zinc-800 rounded" />
    </div>
  );
}

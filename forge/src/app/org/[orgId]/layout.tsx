// src/app/org/[orgId]/layout.tsx
import "@/app/globals.css";
import { OrgProvider } from "@/contexts/OrgContext";
import { Sidebar } from "@/features/organizations/components/Sidebar";

export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ orgId: string }>;
}) {
  const { orgId } = await params;

  return (
    // Main wrapper: Deep zinc background for a professional "Dark Mode" feel
    <div className="flex h-screen bg-zinc-950 text-zinc-100 font-sans antialiased">

      {/* Sidebar Area: Border-r separates it with a subtle dark stroke */}
      <aside className="border-r border-zinc-800/50 bg-zinc-900/30 backdrop-blur-xl">
        <Sidebar orgId={orgId} />
      </aside>

      {/* Main Content Area */}
      <main className="flex-1 flex flex-col overflow-hidden">

        {/* Header: Sticky, Glassmorphism effect */}
        <header className="h-16 border-b border-zinc-800/50 bg-zinc-950/50 backdrop-blur-md flex items-center justify-between px-8">
          <div className="flex items-center gap-3">
            {/* Visual indicator: A small accent square */}
            <div className="h-6 w-1 bg-blue-600 rounded-full" />
            <h1 className="text-sm font-semibold uppercase tracking-widest text-zinc-400">
              Organization <span className="text-zinc-100 ml-2">{orgId}</span>
            </h1>
          </div>

          {/* Right side placeholder for User Profile / Notifications */}
          <div className="flex items-center gap-4">
            <div className="h-8 w-8 rounded-full bg-zinc-800 border border-zinc-700 shadow-inner" />
          </div>
        </header>

        {/* Content: Smooth scrolling with subtle padding adjustment */}
        <div className="flex-1 overflow-y-auto custom-scrollbar">
          <div className="max-w-7xl mx-auto p-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
            <OrgProvider orgSlug={(await params).orgId}>
              {children}
            </OrgProvider>

          </div>
        </div>
      </main>
    </div>
  );
}
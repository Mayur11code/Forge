// src/app/(dashboard)/audit/page.tsx
"use client";

import { useState } from "react";
import { AuditStreamingView } from "@/features/organizations/components/ai/AuditStreamingView";

export default function AuditPage() {
  const [rawCodePayload, setRawCodePayload] = useState("");

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <section className="rounded-xl border border-zinc-800 bg-[#0a0a0a] p-6">
        <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-500">
          Audit input
        </p>

        <h1 className="mt-1 text-xl font-semibold text-zinc-100">
          Paste code or technical context
        </h1>

        <p className="mt-2 text-sm text-zinc-500">
          Include file paths, relevant source code, logs, or an architecture
          description. Do not paste secrets, API keys, or production credentials.
        </p>

        <textarea
          value={rawCodePayload}
          onChange={(event) => setRawCodePayload(event.target.value)}
          placeholder={`Example:

src/app/api/auth/route.ts
...
`}
          rows={14}
          className="mt-5 w-full resize-y rounded-lg border border-zinc-800 bg-zinc-950 p-4 font-mono text-sm leading-6 text-zinc-200 outline-none placeholder:text-zinc-700 focus:border-zinc-600"
        />

        <div className="mt-3 flex items-center justify-between text-xs text-zinc-500">
          <span>Provide enough context for useful findings.</span>
          <span>{rawCodePayload.length.toLocaleString()} characters</span>
        </div>
      </section>

      <AuditStreamingView rawCodePayload={rawCodePayload} />
    </main>
  );
}
"use client";

import { createContext, useContext } from "react";

const OrgContext = createContext<string | null>(null);

export function OrgProvider({
  orgSlug,
  children,
}: {
  orgSlug: string;
  children: React.ReactNode;
}) {
  return (
    <OrgContext.Provider value={orgSlug}>
      {children}
    </OrgContext.Provider>
  );
}

export function useOrgSlug() {
  const value = useContext(OrgContext);
  if (!value) throw new Error("OrgContext missing");
  return value;
}

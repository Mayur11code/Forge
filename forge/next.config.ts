import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js 16.4 enabled strict route matching by default. This app uses a
  // modal-interception pattern at app/org/[orgId]/projects/@modal/new/page.tsx
  // where the URL /org/[orgId]/projects/new has no matching page or default.tsx
  // in the sibling `children` slot. That structure is rejected by strict
  // matching. `deprecated.looseRouteMatching` is the documented escape hatch
  // (https://nextjs.org/docs/messages/loose-route-matching) that restores the
  // pre-16.4 behavior. The underlying route structure should be corrected
  // separately; this flag is intentionally the smallest safe mitigation.
  deprecated: {
    looseRouteMatching: true,
  },
};

export default nextConfig;

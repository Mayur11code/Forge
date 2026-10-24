/**
 * Central Environment Module
 *
 * Architecture:
 * - Server configuration and privileged secrets: import from "@/lib/env/server"
 *   (enforces Next.js compile-time 'server-only' airgap).
 * - Client configuration (browser-safe NEXT_PUBLIC_*): import from "@/lib/env/client"
 *   or "@/lib/env".
 */

export { clientEnv, getClientEnv, clientEnvSchema, type ClientEnv } from "./client";

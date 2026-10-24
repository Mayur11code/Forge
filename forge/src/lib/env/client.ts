import { z } from "zod";

/**
 * Public client-side environment schema.
 * ONLY variables explicitly intended for the browser may be declared here.
 * Privileged server credentials, tokens, and connection strings are strictly
 * forbidden in client bundles.
 */
export const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z
    .string()
    .url("NEXT_PUBLIC_APP_URL must be a valid URL")
    .optional()
    .default("http://localhost:3000"),
  NEXT_PUBLIC_PUSHER_KEY: z.string().optional(),
  NEXT_PUBLIC_PUSHER_CLUSTER: z.string().optional(),
});

export type ClientEnv = z.infer<typeof clientEnvSchema>;

/**
 * Validates and returns the public client environment.
 * Evaluates only the allowlisted browser-safe variables.
 */
export function getClientEnv(): ClientEnv {
  const rawClientEnv = {
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_PUSHER_KEY: process.env.NEXT_PUBLIC_PUSHER_KEY,
    NEXT_PUBLIC_PUSHER_CLUSTER: process.env.NEXT_PUBLIC_PUSHER_CLUSTER,
  };

  const result = clientEnvSchema.safeParse(rawClientEnv);

  if (!result.success) {
    const errorDetails = result.error.issues
      .map((i) => `  - [${i.path.join(".")}]: ${i.message}`)
      .join("\n");
    console.error(
      `[CLIENT ENV] Client environment configuration error:\n${errorDetails}`
    );
    // In browser, return raw values with fallback rather than hard-crashing UI
    return {
      NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
      NEXT_PUBLIC_PUSHER_KEY: process.env.NEXT_PUBLIC_PUSHER_KEY,
      NEXT_PUBLIC_PUSHER_CLUSTER: process.env.NEXT_PUBLIC_PUSHER_CLUSTER,
    };
  }

  return result.data;
}

export const clientEnv = getClientEnv();

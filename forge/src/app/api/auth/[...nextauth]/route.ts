import { handlers } from "@/lib/auth/auth" // Importing the handlers we defined in auth.ts

// Exporting the GET and POST methods as required by Next.js Route Handlers
export const { GET, POST } = handlers


// This file essentially connects the NextAuth configuration
// from auth.ts to the Next.js routing system, allowing
// authentication requests to be properly handled.
import { type DefaultSession } from "next-auth"

// 1. Extend the 'next-auth' module
declare module "next-auth" {
  /**
   * Returned by 'auth', 'useSession', and received as a prop 
   * on the 'SessionProvider' React Context
   */
  interface Session {
    user: {
      id: string
      role: string
      orgId: string | null
      orgSlug: string | null
    } & DefaultSession["user"] // This merges your fields with the default ones
  }

  // 2. Extend the 'User' interface to include these fields 
  // so the 'jwt' callback recognizes them on the 'user' object
  interface User {
    role?: string
    orgId?: string | null
    orgSlug?: string | null
  }
}

// 3. (Optional) Extend the JWT interface if you want type safety inside the jwt() callback
declare module "next-auth/jwt" {
  interface JWT {
    role?: string
    orgId?: string | null
    id?: string
    orgSlug?: string | null
  }
}
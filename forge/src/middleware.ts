import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth/auth.config";

export default NextAuth(authConfig).auth;

export const config = {
  // Protects all routes except static assets and images
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};


// We will not be checking "roles" or authorization in the middleware for now.
// This is because in Next.js , Middleware runs in edge runtime which has limitations
// on the packages and code that can be used. Implementing role-based access control
// would require fetching user roles from a database or an external service, which
// may not be feasible in the edge runtime environment.
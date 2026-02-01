import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth/auth.config";

export default NextAuth(authConfig).auth;

export const config = {
  // Protects all routes except static assets and images
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico).*)"],
};
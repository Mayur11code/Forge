import type { NextAuthConfig } from "next-auth"
import Google from "next-auth/providers/google"

export const authConfig = {
    secret: process.env.AUTH_SECRET,
    pages: {
    signIn: "/login",
  },

  providers: [

    Google({
      clientId: process.env.AUTH_GOOGLE_ID,
      clientSecret: process.env.AUTH_GOOGLE_SECRET,
    }),
  ],
  callbacks: {
    // 1. The Bouncer Logic: Redirects to /login if trying to access /org without a session
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isOrgRoute = nextUrl.pathname.startsWith("/org");

      if (isOrgRoute) {
        if (isLoggedIn) return true;
        return false; // Auth.js automatically redirects to /login
      }
      return true;
    },

    // 2. Base JWT structure
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },

    // 3. Expose custom fields to the Frontend/Session
    async session({ session, token }) {
      if (token && session.user) {
        session.user.id = token.id as string;
        session.user.role = token.role as string;
        session.user.orgId = token.orgId as string;
        session.user.orgSlug = token.orgSlug as string;
      }
      return session;
    },
  },
} satisfies NextAuthConfig;
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";
import { db } from "@/lib/prisma/db";
import bcrypt from "bcryptjs";
import { authConfig } from "./auth.config";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  debug: true,
  adapter: PrismaAdapter(db),

  session: {
    strategy: "jwt",
    maxAge: 60 * 60, // 1 hour
  },

  secret: process.env.AUTH_SECRET,

  providers: [
    ...authConfig.providers,

    Credentials({
      name: "Credentials",
      async authorize(credentials) {
        try {
          if (!credentials?.email || !credentials?.password) {
            return null;
          }

          const user = await db.user.findUnique({
            where: { email: credentials.email as string },
          });

          // No user OR OAuth-only user
          if (!user || !user.password) {
            return null;
          }

          const isValid = await bcrypt.compare(
            credentials.password as string,
            user.password
          );

          if (!isValid) {
            return null;
          }

          // ✅ Identity only
          return {
            id: user.id,
            email: user.email,
            name: user.name,
          };
        } catch (error) {
          console.error("Auth authorize error:", error);
          return null;
        }
      },
    }),
  ],

  callbacks: {
    ...authConfig.callbacks,

    // ✅ Identity-only JWT
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },

    // ✅ Identity-only session
    async session({ session, token }) {
      if (session.user && token.id) {
        session.user.id = token.id as string;
      }
      return session;
    },

    // ✅ Neutral post-login redirect
    async redirect({ baseUrl }) {
      return `${baseUrl}/router`;
    },
  },
});

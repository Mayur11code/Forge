import NextAuth from "next-auth"
import Credentials from "next-auth/providers/credentials"
import { PrismaAdapter } from "@auth/prisma-adapter"
import { db } from "@/lib/prisma/db" // Ensure this path points to your Prisma client
import bcrypt from "bcryptjs"
import { authConfig } from "./auth.config"


export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  debug:true,
  adapter: PrismaAdapter(db),
  session: { strategy: "jwt" ,
    maxAge: 60*60  // 1 hour session expiration
  },
  secret: process.env.AUTH_SECRET, // Explicitly pass the secret here
  providers: [
    ...authConfig.providers,
    Credentials({
      name: "Credentials",
      async authorize(credentials) {
        try {
          if (!credentials?.email || !credentials?.password) return null;

          const user = await db.user.findUnique({
            where: { email: credentials.email as string },
          });

          // If no user found OR user was created via Google (no password)
          if (!user || !user.password) {
            console.log("DEBUG: User not found or has no password");
            return null;
          }

          const isValid = await bcrypt.compare(
            credentials.password as string,
            user.password
          );

          if (!isValid) {
            console.log("DEBUG: Invalid password attempt for:", credentials.email);
            return null;
          }

          return user;
        } catch (error) {
          // This will print the REAL error in your terminal
          console.error("DEBUG: Internal Auth Error during authorize:", error);
          return null;
        }
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    // Inside auth.ts -> callbacks
async jwt({ token, user }) {
  if (user) {
    try {
      // Logic Test: Attempt to find the tenant context
      const membership = await db.membership.findFirst({
            where: { userId: user.id },
            include: {
              organization: true, // This gets the slug without a second query
            },
          });

        const slug = membership?.organization;

      token.id = user.id;
      token.role = membership?.role || "USER";
      token.orgId = membership?.orgId || null;
      token.orgSlug = slug?.slug || null;
    } catch (dbError) {
      console.error("CRITICAL DB ERROR IN JWT CALLBACK:", dbError);
      // Fallback so the app doesn't crash
      token.role = "USER";
      token.orgId = null;
      token.orgSlug = null;
    }
  }
  return token;
},
async redirect({ url, baseUrl }) {
    // Just allow the default behavior or force a specific landing page
    // We do NOT handle the "slug" logic here anymore.
    return `${baseUrl}/router`; 
  }
},
})
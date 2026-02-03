import { db } from "../lib/prisma/db";
import {z}  from "zod";
// import schema.prisma from "../lib/prisma/schema.prisma";

const emailSchema = z.email();

const User = z.object({
    id: z.string(),
    name: z.string().nullable(),
    email: z.email(),
    password: z.string().nullable(),
});

type User = z.infer<typeof User>;
type Email = z.infer<typeof emailSchema>;

export async function getOrg(email: Email): Promise<null | User> {

    const user = await db.user.findUnique({
                where: { email : email },
              });

    if (!user) {
        return null;
    }

    const membership = await db.membership.findFirst({
        where: { userId: user.id },
      });


    const orgSlug = await db.organization.findUnique({
        where: { id: membership?.orgId },
      });

    return { ...user, slug: orgSlug?.slug || null } as User;
}
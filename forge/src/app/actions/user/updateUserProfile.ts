"use server";

import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";
import { revalidatePath } from "next/cache";

export async function updateUserProfile(
  userId: string,
  name: string,
  image?: string | null
) {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Unauthorized");

  if (session.user.id !== userId) {
    throw new Error("Forbidden");
  }

  await db.user.update({
    where: { id: userId },
    data: {
      name,
      image,
    },
  });

  revalidatePath("/");
  revalidatePath("/user/profile");
}

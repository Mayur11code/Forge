"use server";

import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";
import bcrypt from "bcryptjs";
import { revalidatePath } from "next/cache";
import { z } from "zod";

export interface ProfileActionResult {
  success: boolean;
  message?: string;
  error?: string;
}

const updateProfileSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Full name cannot be empty")
    .max(100, "Full name must be 100 characters or less"),
  image: z.string().nullable().optional(),
});

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, "Current password is required"),
    newPassword: z
      .string()
      .min(8, "New password must be at least 8 characters long")
      .max(128, "Password is too long"),
    confirmNewPassword: z.string().min(8, "Please confirm your new password"),
  })
  .refine((data) => data.newPassword === data.confirmNewPassword, {
    message: "New passwords do not match",
    path: ["confirmNewPassword"],
  });

/**
 * Updates the authenticated user's display name and optional avatar.
 * Caller identity is derived strictly from the verified session.
 */
export async function updateUserProfileAction(
  name: string,
  image?: string | null
): Promise<ProfileActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  const parsed = updateProfileSchema.safeParse({ name, image });
  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message || "Invalid profile data",
    };
  }

  try {
    await db.user.update({
      where: { id: session.user.id },
      data: {
        name: parsed.data.name,
        ...(image !== undefined && { image }),
      },
    });

    revalidatePath("/user/profile");
    revalidatePath("/");

    return {
      success: true,
      message: "Profile updated successfully.",
    };
  } catch (err) {
    console.error(
      "[updateUserProfileAction] Error updating profile:",
      err instanceof Error ? err.message : String(err)
    );
    return {
      success: false,
      error: "Failed to update profile. Please try again.",
    };
  }
}

/**
 * Securely changes the authenticated user's password.
 * Validates current password via bcrypt, enforces length >= 8, and hashes with 10 salt rounds.
 */
export async function changePasswordAction(
  currentPassword: string,
  newPassword: string,
  confirmNewPassword: string
): Promise<ProfileActionResult> {
  const session = await auth();
  if (!session?.user?.id) {
    return { success: false, error: "Unauthorized. Please sign in." };
  }

  const parsed = changePasswordSchema.safeParse({
    currentPassword,
    newPassword,
    confirmNewPassword,
  });

  if (!parsed.success) {
    return {
      success: false,
      error: parsed.error.issues[0]?.message || "Invalid password parameters",
    };
  }

  try {
    // 1. Fetch user record with existing password hash
    const user = await db.user.findUnique({
      where: { id: session.user.id },
      select: { id: true, password: true },
    });

    if (!user || !user.password) {
      return {
        success: false,
        error: "User account not found or password not configured.",
      };
    }

    // 2. Verify current password
    const isCurrentValid = await bcrypt.compare(
      parsed.data.currentPassword,
      user.password
    );

    if (!isCurrentValid) {
      return {
        success: false,
        error: "Incorrect current password. Please try again.",
      };
    }

    // 3. Hash new password with bcryptjs (10 salt rounds)
    const newHash = await bcrypt.hash(parsed.data.newPassword, 10);

    // 4. Update in database
    await db.user.update({
      where: { id: session.user.id },
      data: { password: newHash },
    });

    return {
      success: true,
      message:
        "Password changed successfully. Please use your new password next time you sign in.",
    };
  } catch (err) {
    console.error(
      "[changePasswordAction] Error updating password:",
      err instanceof Error ? err.message : String(err)
    );
    return {
      success: false,
      error: "Failed to change password. Please try again.",
    };
  }
}

"use server";

import { db } from "@/lib/prisma/db";
import bcrypt from "bcryptjs";
import { z } from "zod";

const registerSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Full name is required")
      .max(100, "Name must be 100 characters or less"),
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email("Please enter a valid email address"),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters")
      .max(128, "Password must be 128 characters or less"),
    confirmPassword: z
      .string()
      .min(8, "Please confirm your password"),
    inviteToken: z.string().optional().nullable(),
    callbackUrl: z.string().optional().nullable(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match",
    path: ["confirmPassword"],
  });

export type RegisterUserInput = z.infer<typeof registerSchema>;

export interface RegisterUserResult {
  success: boolean;
  userId?: string;
  email?: string;
  nextUrl?: string;
  error?: string;
}

/**
 * Registers a new self-service user in Forge.
 * Enforces email normalization, password hashing via bcryptjs (10 rounds),
 * and email uniqueness constraint.
 */
export async function registerUser(
  input: RegisterUserInput
): Promise<RegisterUserResult> {
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) {
    const firstError = parsed.error.issues[0]?.message || "Invalid registration input";
    return { success: false, error: firstError };
  }

  const { name, email, password, inviteToken, callbackUrl } = parsed.data;
  const normalizedEmail = email.trim().toLowerCase();

  try {
    // 1. Authoritative uniqueness check
    const existing = await db.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true },
    });

    if (existing) {
      return {
        success: false,
        error: "An account with this email address already exists.",
      };
    }

    // 2. Hash password with bcryptjs (10 salt rounds)
    const hashedPassword = await bcrypt.hash(password, 10);

    // 3. Create User record
    const newUser = await db.user.create({
      data: {
        name: name.trim(),
        email: normalizedEmail,
        password: hashedPassword,
      },
      select: {
        id: true,
        email: true,
        name: true,
      },
    });

    // 4. Determine secure navigation target
    let nextUrl = "/router";
    if (inviteToken && inviteToken.trim()) {
      nextUrl = `/invite/${encodeURIComponent(inviteToken.trim())}`;
    } else if (
      callbackUrl &&
      callbackUrl.startsWith("/") &&
      !callbackUrl.startsWith("//") &&
      !callbackUrl.includes("\\")
    ) {
      nextUrl = callbackUrl;
    }

    return {
      success: true,
      userId: newUser.id,
      email: newUser.email,
      nextUrl,
    };
  } catch (err) {
    console.error(
      "[registerUser] Database failure during user creation:",
      err instanceof Error ? err.message : String(err)
    );
    return {
      success: false,
      error: "An unexpected error occurred while creating your account. Please try again.",
    };
  }
}

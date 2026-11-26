import bcrypt from "bcryptjs";

// Mock the database
jest.mock("@/lib/prisma/db", () => ({
  db: {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
  },
}));

import { db } from "@/lib/prisma/db";
import { registerUser } from "@/app/actions/user/registerUser";

describe("registerUser action (FC-002)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("successfully registers a new user with bcrypt-hashed password and defaults to /router", async () => {
    (db.user.findUnique as jest.Mock).mockResolvedValue(null);
    (db.user.create as jest.Mock).mockImplementation(async ({ data }) => ({
      id: "user_test_123",
      email: data.email,
      name: data.name,
    }));

    const result = await registerUser({
      name: "Jane Doe",
      email: "Jane.Doe@EXAMPLE.COM",
      password: "SuperSecretPassword123!",
      confirmPassword: "SuperSecretPassword123!",
    });

    expect(result.success).toBe(true);
    expect(result.userId).toBe("user_test_123");
    expect(result.email).toBe("jane.doe@example.com");
    expect(result.nextUrl).toBe("/router");

    // Verify database queries
    expect(db.user.findUnique).toHaveBeenCalledWith({
      where: { email: "jane.doe@example.com" },
      select: { id: true },
    });

    expect(db.user.create).toHaveBeenCalledTimes(1);
    const createCallData = (db.user.create as jest.Mock).mock.calls[0][0].data;
    expect(createCallData.name).toBe("Jane Doe");
    expect(createCallData.email).toBe("jane.doe@example.com");

    // Verify password is not stored in plaintext and is valid bcrypt hash
    expect(createCallData.password).not.toBe("SuperSecretPassword123!");
    expect(createCallData.password.startsWith("$2")).toBe(true);
    const isPasswordValid = await bcrypt.compare(
      "SuperSecretPassword123!",
      createCallData.password
    );
    expect(isPasswordValid).toBe(true);
  });

  it("rejects registration when email already exists", async () => {
    (db.user.findUnique as jest.Mock).mockResolvedValue({ id: "existing_user_id" });

    const result = await registerUser({
      name: "Existing Person",
      email: "existing@example.com",
      password: "SuperSecretPassword123!",
      confirmPassword: "SuperSecretPassword123!",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("already exists");
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("rejects registration when passwords do not match", async () => {
    const result = await registerUser({
      name: "Jane Doe",
      email: "jane@example.com",
      password: "Password1234",
      confirmPassword: "DifferentPassword1234",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Passwords do not match");
    expect(db.user.findUnique).not.toHaveBeenCalled();
    expect(db.user.create).not.toHaveBeenCalled();
  });

  it("rejects registration when password is shorter than 8 characters", async () => {
    const result = await registerUser({
      name: "Jane Doe",
      email: "jane@example.com",
      password: "short",
      confirmPassword: "short",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("at least 8 characters");
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects registration when name is empty or whitespace", async () => {
    const result = await registerUser({
      name: "   ",
      email: "jane@example.com",
      password: "Password1234",
      confirmPassword: "Password1234",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Full name is required");
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects registration when email format is invalid", async () => {
    const result = await registerUser({
      name: "Jane Doe",
      email: "not-an-email",
      password: "Password1234",
      confirmPassword: "Password1234",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("valid email address");
    expect(db.user.findUnique).not.toHaveBeenCalled();
  });

  it("preserves inviteToken in nextUrl navigation target", async () => {
    (db.user.findUnique as jest.Mock).mockResolvedValue(null);
    (db.user.create as jest.Mock).mockResolvedValue({
      id: "invited_user_id",
      email: "invited@example.com",
      name: "Invited User",
    });

    const result = await registerUser({
      name: "Invited User",
      email: "invited@example.com",
      password: "Password1234",
      confirmPassword: "Password1234",
      inviteToken: "token_abc_xyz",
    });

    expect(result.success).toBe(true);
    expect(result.nextUrl).toBe("/invite/token_abc_xyz");
  });

  it("preserves safe internal callbackUrl in nextUrl navigation target", async () => {
    (db.user.findUnique as jest.Mock).mockResolvedValue(null);
    (db.user.create as jest.Mock).mockResolvedValue({
      id: "cb_user_id",
      email: "cb@example.com",
      name: "Callback User",
    });

    const result = await registerUser({
      name: "Callback User",
      email: "cb@example.com",
      password: "Password1234",
      confirmPassword: "Password1234",
      callbackUrl: "/org/test-org/dashboard",
    });

    expect(result.success).toBe(true);
    expect(result.nextUrl).toBe("/org/test-org/dashboard");
  });

  it("falls back to /router when callbackUrl is external or protocol-relative", async () => {
    (db.user.findUnique as jest.Mock).mockResolvedValue(null);
    (db.user.create as jest.Mock).mockResolvedValue({
      id: "safe_user_id",
      email: "safe@example.com",
      name: "Safe User",
    });

    const result = await registerUser({
      name: "Safe User",
      email: "safe@example.com",
      password: "Password1234",
      confirmPassword: "Password1234",
      callbackUrl: "//evil.com/phish",
    });

    expect(result.success).toBe(true);
    expect(result.nextUrl).toBe("/router");
  });

  it("handles unexpected database errors gracefully without leaking stack traces", async () => {
    (db.user.findUnique as jest.Mock).mockRejectedValue(
      new Error("FATAL: connection limit exceeded (database error code 53300)")
    );

    const result = await registerUser({
      name: "Jane Doe",
      email: "jane@example.com",
      password: "Password1234",
      confirmPassword: "Password1234",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe(
      "An unexpected error occurred while creating your account. Please try again."
    );
    expect(result.error).not.toContain("FATAL");
    expect(result.error).not.toContain("53300");
  });
});

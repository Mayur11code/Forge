import bcrypt from "bcryptjs";

jest.mock("@/lib/auth/auth", () => ({
  auth: jest.fn(),
}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    user: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
  },
}));

jest.mock("next/cache", () => ({
  revalidatePath: jest.fn(),
}));

import { auth } from "@/lib/auth/auth";
import { db } from "@/lib/prisma/db";
import {
  updateUserProfileAction,
  changePasswordAction,
} from "@/app/actions/user/profileActions";

describe("Profile & Account Management Server Actions (FC-007)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("updateUserProfileAction", () => {
    it("rejects unauthenticated caller", async () => {
      (auth as jest.Mock).mockResolvedValue(null);

      const result = await updateUserProfileAction("New Name");
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unauthorized");
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it("rejects empty or whitespace display name", async () => {
      (auth as jest.Mock).mockResolvedValue({
        user: { id: "user-123", email: "user@example.com" },
      });

      const result = await updateUserProfileAction("   ");
      expect(result.success).toBe(false);
      expect(result.error).toContain("cannot be empty");
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it("successfully updates name and avatar image", async () => {
      (auth as jest.Mock).mockResolvedValue({
        user: { id: "user-123", email: "user@example.com" },
      });

      (db.user.update as jest.Mock).mockResolvedValue({});

      const result = await updateUserProfileAction(
        "Alex Ferguson",
        "https://example.com/avatar.png"
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain("Profile updated successfully");
      expect(db.user.update).toHaveBeenCalledWith({
        where: { id: "user-123" },
        data: {
          name: "Alex Ferguson",
          image: "https://example.com/avatar.png",
        },
      });
    });
  });

  describe("changePasswordAction", () => {
    it("rejects unauthenticated caller", async () => {
      (auth as jest.Mock).mockResolvedValue(null);

      const result = await changePasswordAction(
        "OldPassword123!",
        "NewPassword123!",
        "NewPassword123!"
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Unauthorized");
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it("rejects when new password is shorter than 8 characters", async () => {
      (auth as jest.Mock).mockResolvedValue({
        user: { id: "user-123", email: "user@example.com" },
      });

      const result = await changePasswordAction(
        "OldPassword123!",
        "short",
        "short"
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("at least 8 characters");
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it("rejects when new passwords do not match", async () => {
      (auth as jest.Mock).mockResolvedValue({
        user: { id: "user-123", email: "user@example.com" },
      });

      const result = await changePasswordAction(
        "OldPassword123!",
        "NewPassword123!",
        "MismatchPassword123!"
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe("New passwords do not match");
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it("rejects when current password does not match persisted hash", async () => {
      (auth as jest.Mock).mockResolvedValue({
        user: { id: "user-123", email: "user@example.com" },
      });

      const realPasswordHash = await bcrypt.hash("CorrectCurrentPassword123!", 10);
      (db.user.findUnique as jest.Mock).mockResolvedValue({
        id: "user-123",
        password: realPasswordHash,
      });

      const result = await changePasswordAction(
        "WrongCurrentPassword999!",
        "BrandNewPassword123!",
        "BrandNewPassword123!"
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Incorrect current password");
      expect(db.user.update).not.toHaveBeenCalled();
    });

    it("successfully updates password with new bcrypt hash when current password is valid", async () => {
      (auth as jest.Mock).mockResolvedValue({
        user: { id: "user-123", email: "user@example.com" },
      });

      const existingHash = await bcrypt.hash("OldPassword123!", 10);
      (db.user.findUnique as jest.Mock).mockResolvedValue({
        id: "user-123",
        password: existingHash,
      });

      (db.user.update as jest.Mock).mockResolvedValue({});

      const result = await changePasswordAction(
        "OldPassword123!",
        "BrandNewSecurePassword456!",
        "BrandNewSecurePassword456!"
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain("Password changed successfully");

      expect(db.user.update).toHaveBeenCalledTimes(1);
      const updateArgs = (db.user.update as jest.Mock).mock.calls[0][0];
      expect(updateArgs.where).toEqual({ id: "user-123" });

      const updatedHash = updateArgs.data.password;
      expect(updatedHash).not.toBe("BrandNewSecurePassword456!");
      expect(updatedHash.startsWith("$2")).toBe(true);

      // Verify new password validates against the new hash
      const isValidNew = await bcrypt.compare(
        "BrandNewSecurePassword456!",
        updatedHash
      );
      expect(isValidNew).toBe(true);

      // Verify old password fails against the new hash
      const isOldValid = await bcrypt.compare(
        "OldPassword123!",
        updatedHash
      );
      expect(isOldValid).toBe(false);
    });
  });
});

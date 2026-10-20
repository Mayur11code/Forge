// src/tests/security/public-error.test.ts
//
// S5 (strengthened) — allowlist projection of internal errors onto a
// client-safe string.
//
// These are pure-function tests over representative error messages: a Postgres
// error, a filesystem error, a provider/SDK error, and a stack-bearing error.
// The property under test is that NONE of them survive projection, that authored
// user-facing messages do survive, and that nothing multi-line ever escapes.

import {
  toPublicError,
  GENERIC_PUBLIC_ERROR,
} from "@/lib/security/public-error";

describe("toPublicError", () => {
  it("returns null for null/undefined/empty", () => {
    expect(toPublicError(null)).toBeNull();
    expect(toPublicError(undefined)).toBeNull();
    expect(toPublicError("")).toBeNull();
    expect(toPublicError("   ")).toBeNull();
  });

  it("passes through an authored, user-facing message", () => {
    expect(toPublicError("Tool input cannot be null.")).toBe(
      "Tool input cannot be null.",
    );
    expect(toPublicError("The criticality decisions are invalid.")).toBe(
      "The criticality decisions are invalid.",
    );
  });

  it("collapses a Postgres/database error to the generic message", () => {
    // Representative Prisma/Postgres failure: constraint name + table detail.
    const dbError =
      'Unique constraint failed on the fields: (`email`) at prisma.agentToolExecution.update';
    expect(toPublicError(dbError)).toBe(GENERIC_PUBLIC_ERROR);
    expect(toPublicError(dbError)).not.toContain("constraint");
    expect(toPublicError(dbError)).not.toContain("prisma");
  });

  it("collapses a filesystem error to the generic message", () => {
    const fsError =
      "ENOENT: no such file or directory, open 'C:\\\\Users\\\\Mayur\\\\Desktop\\\\Forge\\\\forge\\\\secret.ts'";
    const result = toPublicError(fsError);
    expect(result).toBe(GENERIC_PUBLIC_ERROR);
    expect(result).not.toContain("C:");
    expect(result).not.toContain("ENOENT");
  });

  it("collapses a provider/SDK error to the generic message", () => {
    const providerError =
      "GoogleGenerativeAI Error: [400] API key not valid. Please pass a valid API key.";
    const result = toPublicError(providerError);
    expect(result).toBe(GENERIC_PUBLIC_ERROR);
    expect(result).not.toContain("API key");
  });

  it("never returns a multi-line or stack-bearing value", () => {
    const stackError =
      "Tool input cannot be null.\n    at execute (/app/src/lib/tool.ts:42:9)\n    at run (/app/src/worker.ts:99:1)";
    const result = toPublicError(stackError);
    // The first line is an allowlisted message, so it IS returned - but only
    // that line; no frame, no path.
    expect(result).toBe("Tool input cannot be null.");
    expect(result).not.toContain("at ");
    expect(result).not.toContain("/app/");
  });

  it("collapses an unrecognised single-line error to the generic message", () => {
    expect(toPublicError("Something exploded internally")).toBe(
      GENERIC_PUBLIC_ERROR,
    );
  });

  it("does not leak the raw text of a stack that starts with an unsafe line", () => {
    const stackError =
      "Error: connect ECONNREFUSED 10.0.0.5:5432\n    at TCPConnectWrap.afterConnect";
    const result = toPublicError(stackError);
    expect(result).toBe(GENERIC_PUBLIC_ERROR);
    expect(result).not.toContain("ECONNREFUSED");
    expect(result).not.toContain("10.0.0.5");
  });
});

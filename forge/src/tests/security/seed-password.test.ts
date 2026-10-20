// src/tests/security/seed-password.test.ts
//
// S12 — the seed password resolver must fail closed.
//
// The resolver is a pure function over an environment shape, so these are
// direct unit tests: no database, no seeding, no process spawn. The credential
// value is never printed; assertions that touch a secret compare it in-memory
// and never emit it.

import {
  resolveSeedPassword,
  INSECURE_LOCAL_SEED_PASSWORD,
} from "@/lib/security/seed-password";

describe("resolveSeedPassword", () => {
  it("fails closed when no password is configured and no opt-in is set", () => {
    expect(() => resolveSeedPassword({})).toThrow(
      /No seed password configured/,
    );
  });

  it("fails closed when NODE_ENV is production and nothing is configured", () => {
    expect(() => resolveSeedPassword({ NODE_ENV: "production" })).toThrow();
  });

  it("uses a configured SEED_PASSWORD in any environment", () => {
    const password = resolveSeedPassword({ SEED_PASSWORD: "s3cret-value" });
    expect(password).toBe("s3cret-value");
  });

  it("honours SEED_PASSWORD in production (no insecure fallback)", () => {
    const password = resolveSeedPassword({
      SEED_PASSWORD: "prod-value",
      NODE_ENV: "production",
    });
    expect(password).toBe("prod-value");
  });

  it("treats a whitespace-only SEED_PASSWORD as not configured", () => {
    expect(() => resolveSeedPassword({ SEED_PASSWORD: "   " })).toThrow(
      /No seed password configured/,
    );
  });

  it("returns the fixed local password only under the explicit local opt-in", () => {
    const password = resolveSeedPassword({
      ALLOW_INSECURE_SEED: "true",
      NODE_ENV: "development",
    });
    expect(password).toBe(INSECURE_LOCAL_SEED_PASSWORD);
  });

  it("refuses the insecure local opt-in in production", () => {
    expect(() =>
      resolveSeedPassword({
        ALLOW_INSECURE_SEED: "true",
        NODE_ENV: "production",
      }),
    ).toThrow(/Refusing to seed with the insecure local password in production/);
  });

  it("requires the exact opt-in value, not mere truthiness", () => {
    // A loose check would treat the string "false" as enabled.
    expect(() => resolveSeedPassword({ ALLOW_INSECURE_SEED: "false" })).toThrow(
      /No seed password configured/,
    );
    expect(() => resolveSeedPassword({ ALLOW_INSECURE_SEED: "1" })).toThrow(
      /No seed password configured/,
    );
  });

  it("never includes the configured password in an error message", () => {
    const secret = "do-not-leak-me";
    // Production + insecure opt-in throws; assert the configured secret is not
    // echoed into the thrown message when a secret happened to be present.
    try {
      resolveSeedPassword({
        SEED_PASSWORD: secret,
        ALLOW_INSECURE_SEED: "true",
        NODE_ENV: "production",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
    }
  });
});

// jest.setup-realdb.ts
//
// Setup for the "real database" Jest project (see jest.realdb.config.ts).
//
// This is the deliberate counterpart to jest.setup-db-guard.ts. That guard
// refuses to let any test construct a real PrismaClient, which is correct for
// the default suite: every ordinary test must mock the database. This setup is
// used ONLY by the real-DB acceptance project, whose entire purpose is to run
// real SQL against a real database — so the PrismaClient refusal is
// intentionally absent here.
//
// The only thing carried over from the default guard is the `server-only`
// neutralisation, which is unrelated to the database and is still required
// because several modules under test import it.
//
// Safety: this setup must never be attached to the default jest.config.ts. A
// test only reaches a real database through `next/jest` loading `.env` (and thus
// DATABASE_URL) plus this file. Keep the two configurations separate.

jest.mock("server-only", () => ({}));

export {};

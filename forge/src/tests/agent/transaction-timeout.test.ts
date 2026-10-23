// src/tests/agent/transaction-timeout.test.ts
//
// Assignment 37.16 — regression guard for the live P2028 transaction-timeout
// failure found during the capstone run.
//
// THE DEFECT
// ----------
// The live capstone stalled at agent step 1. The tool outcome transaction in
// `src/lib/ai/agent/tool-worker.ts` failed with:
//
//   PrismaClientKnownRequestError (P2028): A commit cannot be executed on an
//   expired transaction. The timeout for this transaction was 5000 ms, however
//   12177 ms passed since the start of the transaction.
//
// Nothing in the agent's logic was wrong. The transaction body was a correct,
// finite sequence of statements, and it committed nothing because Prisma's
// DEFAULT interactive-transaction ceiling (5000 ms) had passed by the time the
// COMMIT was issued. The database is a remote Neon instance reached over the
// public internet, where a cold connection alone costs seconds and every
// statement inside the transaction is a separate network round trip.
//
// WHY A MOCKED SUITE CANNOT CATCH IT
// ----------------------------------
// The prisma double resolves every query instantly, so the 5-second ceiling is
// unreachable in every mocked suite. The failure is only observable against a
// real database over a real network — which is exactly why the capstone found
// it and the 37.15 test matrix did not.
//
// WHAT THIS FILE DOES
// -------------------
// Two things, both cheap and deterministic:
//
//   1. A STRUCTURAL invariant over `src/lib/ai/agent/**`: every interactive
//      `$transaction` in the agent path must carry the shared, non-default
//      transaction options. This is the guard. It fails the moment someone
//      adds a new agent transaction without the options, or drops them from an
//      existing one — the two ways this defect can come back.
//
//   2. A BEHAVIOURAL assertion through the real `startAgentSession` code path:
//      the options are not merely present in the source, they are the second
//      argument the service hands to Prisma.
//
// The real-database reproduction of the underlying P2028 lives in
// `src/tests/agent/transaction-timeout.realdb.test.ts`, because it needs a real
// network to be slow.

jest.mock("server-only", () => ({}));

jest.mock("@/lib/prisma/extended", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { prisma: prismaDouble };
});

jest.mock("@/lib/prisma/db", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prismaDouble } = require("./helpers/prisma-double");
  return { db: prismaDouble };
});

import fs from "node:fs";
import path from "node:path";

import { db } from "@/lib/prisma/db";
import { AGENT_TRANSACTION_OPTIONS } from "@/lib/prisma/transaction-options";
import { startAgentSession } from "@/lib/ai/agent/orchestrator";
import { resetStore, restorePrismaDouble } from "./helpers/prisma-double";

const AGENT_ROOT = path.join(process.cwd(), "src", "lib", "ai", "agent");

function collectAgentSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectAgentSources(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

afterEach(() => {
  restorePrismaDouble();
  resetStore();
});

describe("agent interactive-transaction options", () => {
  it("raises the Prisma interactive-transaction ceiling above the 5000 ms default", () => {
    // The defaults Prisma applies when no options are passed. The defect was
    // produced by these exact numbers.
    expect(AGENT_TRANSACTION_OPTIONS.timeout).toBeGreaterThan(5000);
    expect(AGENT_TRANSACTION_OPTIONS.maxWait).toBeGreaterThan(2000);
  });

  it("covers every interactive $transaction in the agent path", () => {
    const files = collectAgentSources(AGENT_ROOT);
    expect(files.length).toBeGreaterThan(0);

    let totalTransactions = 0;
    const uncovered: string[] = [];

    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      const transactions = countOccurrences(source, "$transaction(async");
      if (transactions === 0) continue;
      totalTransactions += transactions;

      // The options are passed as the second argument of the call, and the
      // import brings them in. Count the argument usages (not the import).
      const optionUsages =
        countOccurrences(source, "}, AGENT_TRANSACTION_OPTIONS);") +
        countOccurrences(source, "}, AGENT_TRANSACTION_OPTIONS) ");

      if (optionUsages !== transactions) {
        uncovered.push(
          `${path.relative(process.cwd(), file)}: ${transactions} transaction(s), ${optionUsages} with options`,
        );
      }

      // The options must come from the shared constant, so that one place
      // governs the ceiling. An inline literal would drift.
      if (!source.includes(
        'import { AGENT_TRANSACTION_OPTIONS } from "@/lib/prisma/transaction-options"',
      )) {
        uncovered.push(
          `${path.relative(process.cwd(), file)}: does not import the shared transaction options`,
        );
      }
    }

    // A guard that silently passes because the scan found nothing is worse
    // than no guard.
    expect(totalTransactions).toBeGreaterThan(0);
    expect(uncovered).toEqual([]);
  });

  it("passes the options to Prisma from the real agent service", async () => {
    await startAgentSession({
      orgId: "org_txn_guard",
      userId: "user_txn_guard",
      initialMessage: {
        role: "user",
        content: "Onboard Acme Enterprise.",
      },
    });

    const transactionMock = db.$transaction as jest.Mock;
    expect(transactionMock).toHaveBeenCalledTimes(1);

    const [, options] = transactionMock.mock.calls[0] as [
      (tx: unknown) => Promise<unknown>,
      { maxWait: number; timeout: number },
    ];
    expect(options).toEqual(AGENT_TRANSACTION_OPTIONS);
    expect(options.timeout).toBeGreaterThan(5000);
  });
});

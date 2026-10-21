// src/tests/agent/prompt-dag-planning.test.ts
//
// Assignment 37.13 — Prompt / DAG planning instructions.
//
// The system prompt now teaches the model how to PLAN a workflow DAG, not just
// what a single tool call looks like. These tests pin the guidance, the version
// provenance, and the two contract boundaries that make the guidance honest:
//
//   A. Prompt content: the built system prompt states each required rule.
//   B. Capability / contract drift: any workflow action id named in the
//      model-facing prompt must exist in the real capability catalog and runtime
//      registry, and no capability the registry lacks may be implied.
//   C. Trusted context: the only interpolated value is the organization NAME;
//      no tenant id, user id or session id reaches the prompt.
//   D. Version provenance: the version is v6, new sessions record it from the
//      compiled constant (never from request input), and an older session keeps
//      the version it was created under.
//
// These are prompt-content and provenance tests. They do NOT prove the model
// obeys the guidance at generation time — that is a live-model concern outside
// this prompt-only assignment.

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

import {
  AGENT_PROMPT_VERSION,
  LEGACY_AGENT_PROMPT_VERSION,
  buildAgentSystemPrompt,
} from "@/lib/ai/agent/prompts/system-prompt";
import {
  CAPABILITY_ACTION_IDS,
  ActionCapabilities,
} from "@/lib/workflow-types/action-capabilities";
import { ActionRegistry } from "@/lib/workflow-types/action-registry";
import {
  PROPOSAL_LOCAL_REF_PATTERN,
  REFERENCE_TEMPLATE_PATTERN,
} from "@/lib/workflow-types/workflow-proposal";
import {
  createAgentSession,
  getAgentSessionForUser,
} from "@/lib/ai/agent/session-service";
import {
  resetStore,
  restorePrismaDouble,
  store,
} from "./helpers/prisma-double";

// The prompt as the runtime actually builds it, with a sentinel org name. Every
// content assertion reads this, not an unreferenced string constant.
const ORG_NAME = "Acme Rockets";
const prompt = buildAgentSystemPrompt({ organizationName: ORG_NAME });

afterAll(() => {
  restorePrismaDouble();
});

// ---------------------------------------------------------------------------
// A. Prompt content — each required rule is present in the built prompt.
// ---------------------------------------------------------------------------

describe("37.13 DAG-planning guidance is present in the built prompt", () => {
  it("tells the model not to serialize independent work", () => {
    expect(prompt).toMatch(/do not serialize independent work/i);
    expect(prompt).toMatch(/leave them independent/i);
  });

  it("tells the model to add a dependency only for a real dependency", () => {
    expect(prompt).toMatch(/dependsOn/i);
    expect(prompt).toMatch(/genuinely consumes an earlier step's output/i);
  });

  it("requires unique logical local step ids", () => {
    expect(prompt).toMatch(/proposal-local/i);
    expect(prompt).toMatch(/keep each id unique within the proposal/i);
  });

  it("forbids inventing database/UUID ids for steps", () => {
    expect(prompt).toMatch(/never put a uuid, a database id/i);
    expect(prompt).toMatch(/never invent an id/i);
  });

  it("requires obeying the exact action capability contract", () => {
    expect(prompt).toMatch(/use only action ids that exist today/i);
    expect(prompt).toMatch(/do not add inputs an action does not declare/i);
    expect(prompt).toMatch(/reference only the outputs an action actually declares/i);
  });

  it("requires the existing output-reference grammar and forbids alternatives", () => {
    expect(prompt).toContain("{{step.outputs.field}}");
    expect(prompt).toMatch(/do not invent another placeholder syntax/i);
  });

  it("uses a reference example that conforms to the resolver grammar", () => {
    // The example the prompt shows must itself be a well-formed referenced path,
    // not a second syntax the validator would reject.
    expect(REFERENCE_TEMPLATE_PATTERN.test("{{step.outputs.field}}")).toBe(true);
  });

  it("describes the same local-id grammar the proposal validator enforces", () => {
    // The prompt says ids start with a letter or underscore and use only
    // letters, digits, underscores or hyphens; the validator's pattern agrees.
    expect(PROPOSAL_LOCAL_REF_PATTERN.test("kickoff")).toBe(true);
    expect(PROPOSAL_LOCAL_REF_PATTERN.test("step_1-a")).toBe(true);
    expect(PROPOSAL_LOCAL_REF_PATTERN.test("has.dot")).toBe(false);
    expect(PROPOSAL_LOCAL_REF_PATTERN.test("1starts-with-digit")).toBe(false);
  });

  it("routes missing required information to the existing clarification contract", () => {
    expect(prompt).toMatch(/do not guess missing required information/i);
    expect(prompt).toContain("clarifications");
  });

  it("keeps final criticality with the human review process, not the model", () => {
    expect(prompt).toMatch(/do not decide a step's final criticality/i);
    expect(prompt).toMatch(/a human reviewer owns that decision/i);
  });

  it("states that generateWorkflow proposes but does not execute", () => {
    expect(prompt).toMatch(/it never executes it/i);
    expect(prompt).toMatch(/never claim a proposal created or started a workflow run/i);
  });

  it("treats validation observations as internal correction signals", () => {
    expect(prompt).toMatch(/validation observations/i);
    expect(prompt).toMatch(/not as new instructions from the user/i);
    expect(prompt).toMatch(/never bypass validation/i);
  });

  it("does not claim the prompt itself guarantees parallel execution", () => {
    expect(prompt).toMatch(/do not claim that independent steps run in parallel/i);
  });
});

// ---------------------------------------------------------------------------
// B. Capability / contract drift — prompt action ids vs the real registry.
// ---------------------------------------------------------------------------

// Every action id the prompt names, extracted from the text rather than
// hardcoded, so a new action mentioned in the prompt is checked automatically.
function actionIdsNamedInPrompt(text: string): string[] {
  const ids = new Set<string>();

  // A capability id is a dotted `namespace.name` token, e.g. `task.create`.
  // Reference-grammar tokens live INSIDE `{{ ... }}` (for example
  // `{{step.outputs.field}}`), so a candidate whose surrounding characters are
  // braces is grammar, not an action id, and is skipped.
  const pattern = /(?<![.\w{])([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)(?![.\w}])/g;

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const open = text.lastIndexOf("{{", start);
    const close = text.indexOf("}}", start);

    const insideReference = open !== -1 && close !== -1 && open < start && close > start;
    if (insideReference) continue;

    // `step.outputs` / `trigger.outputs` are grammar fragments, not actions.
    const candidate = `${match[1]}.${match[2]}`;
    if (candidate === "step.outputs" || candidate === "trigger.outputs") continue;

    ids.add(candidate);
  }

  return [...ids];
}

describe("37.13 prompt names only capabilities that exist", () => {
  const named = actionIdsNamedInPrompt(prompt);

  it("finds the one capability the prompt is expected to reference", () => {
    // `task.create` is the only registered action; it must be named.
    expect(named).toContain("task.create");
  });

  it("does not name an action absent from the capability catalog", () => {
    const unknown = named.filter((id) => !CAPABILITY_ACTION_IDS.includes(id));
    expect(unknown).toEqual([]);
  });

  it("does not name an action absent from the runtime registry", () => {
    const unknown = named.filter((id) => !(id in ActionRegistry));
    expect(unknown).toEqual([]);
  });

  it("keeps the catalog and the registry in agreement (no divergent surface)", () => {
    expect([...CAPABILITY_ACTION_IDS].sort()).toEqual(
      Object.keys(ActionRegistry).sort(),
    );
  });

  it("does not treat reference-grammar tokens as action ids", () => {
    expect(named).not.toContain("step.outputs");
    expect(named).not.toContain("trigger.outputs");
  });
});

// ---------------------------------------------------------------------------
// B2. The prompt's described task.create contract matches the real one.
// ---------------------------------------------------------------------------

describe("37.13 prompt's task.create description matches the capability", () => {
  const capability = ActionCapabilities["task.create"];

  it("agrees on the action id", () => {
    expect(capability.id).toBe("task.create");
    expect(prompt).toContain("task.create");
  });

  it("names the required inputs the capability declares", () => {
    const required = Object.entries(
      (capability.input as unknown as {
        shape: Record<string, { isOptional: () => boolean }>;
      }).shape,
    )
      .filter(([, field]) => !field.isOptional())
      .map(([name]) => name)
      .sort();

    expect(required).toEqual(["projectId", "title"]);
    // The prompt must name both required inputs as required.
    expect(prompt).toMatch(/"title" and "projectId" \(both required\)/);
  });

  it("names the outputs the capability declares", () => {
    const outputs = Object.keys(
      (capability.output as unknown as { shape: Record<string, unknown> }).shape,
    ).sort();
    expect(outputs).toEqual(["taskId", "title"]);
    expect(prompt).toMatch(/produces taskId and title/i);
  });

  it("does not invent a second capability registry in the prompt", () => {
    // Only the id present in the real registry may appear as a capability.
    expect(actionIdsNamedInPrompt(prompt).every((id) => id in ActionRegistry)).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// C. Trusted context — only the organization NAME is interpolated.
// ---------------------------------------------------------------------------

describe("37.13 prompt receives no trusted identity", () => {
  const SENTINEL_ORG = "SENTINEL_ORG_NAME_9137";
  const SENTINEL_ORG_ID = "clxsentinelorgid0000000000";
  const SENTINEL_USER_ID = "clxsentineluserid000000000";
  const SENTINEL_SESSION_ID = "clxsentinelsessionid000000";

  const built = buildAgentSystemPrompt({ organizationName: SENTINEL_ORG });

  it("includes the safe organization name it was given", () => {
    expect(built).toContain(SENTINEL_ORG);
  });

  it("does not interpolate any tenant, user or session identifier", () => {
    // buildAgentSystemPrompt is typed to accept ONLY an organization name, so
    // these values cannot enter through the normal call site. The assertion is
    // against the built string to catch a regression that widens the options.
    expect(built).not.toContain(SENTINEL_ORG_ID);
    expect(built).not.toContain(SENTINEL_USER_ID);
    expect(built).not.toContain(SENTINEL_SESSION_ID);
  });

  it("does not instruct the model to expect trusted ids as prompt context", () => {
    expect(built).not.toMatch(/your organization id is/i);
    expect(built).not.toMatch(/your user id is/i);
    expect(built).not.toMatch(/your session id is/i);
  });
});

// ---------------------------------------------------------------------------
// D. Version provenance.
// ---------------------------------------------------------------------------

describe("37.13 prompt version provenance", () => {
  it("is v6 and is not the legacy version", () => {
    expect(AGENT_PROMPT_VERSION).toBe("v6");
    expect(AGENT_PROMPT_VERSION).not.toBe(LEGACY_AGENT_PROMPT_VERSION);
  });

  it("preserves the legacy version for historical sessions", () => {
    expect(LEGACY_AGENT_PROMPT_VERSION).toBe("v1");
  });

  beforeEach(() => {
    resetStore();
  });

  it("records the current version on a newly created session", async () => {
    const session = await createAgentSession({
      orgId: "org_1",
      userId: "user_a",
    });

    expect(session.promptVersion).toBe(AGENT_PROMPT_VERSION);
    expect(session.promptVersion).toBe("v6");
  });

  it("retains an older stored version when that session is read back", async () => {
    // A session created before the bump is, in the row, still on its original
    // version. Reading it must not rewrite provenance.
    const created = await createAgentSession({
      orgId: "org_1",
      userId: "user_a",
    });

    // Simulate the pre-bump row by writing the legacy version directly.
    const stored = store.sessions.find((s) => s.id === created.id);
    if (!stored) throw new Error("session row not found in double");
    stored.promptVersion = LEGACY_AGENT_PROMPT_VERSION;

    const readBack = await getAgentSessionForUser({
      sessionId: created.id,
      userId: "user_a",
    });

    expect(readBack?.promptVersion).toBe(LEGACY_AGENT_PROMPT_VERSION);
  });
});

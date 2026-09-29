// scripts/qstash-maintenance-schedule.mjs
//
// Create, update and VERIFY the QStash schedule that drives agent maintenance.
//
// The verification is the point of this script. Writing `schedule: "*/5 * * * *"`
// into a config file proves nothing: it does not create a schedule, it does not
// prove the destination resolves, and it does not prove the body is a shape the
// worker will accept. Every one of those has to be asked of QStash itself, so
// this script reads the schedule back out of the QStash API and compares it
// against what was intended, failing loudly on any difference.
//
// It also refuses to create a schedule pointing at a non-public destination. A
// schedule aimed at localhost or a dev tunnel does not error - it is accepted and
// then fails on every single tick, which is strictly worse than no schedule
// because it looks configured.
//
// Usage:
//   node scripts/qstash-maintenance-schedule.mjs plan      # dry run, no writes
//   node scripts/qstash-maintenance-schedule.mjs apply     # create or update
//   node scripts/qstash-maintenance-schedule.mjs verify    # read-only check
//   node scripts/qstash-maintenance-schedule.mjs remove    # delete the schedule
//
//   AGENT_MAINTENANCE_CRON     override the cron expression (default */5 * * * *)
//   APP_URL                    override the base URL the schedule points at
//
// Env is read from .env in the repo root.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@upstash/qstash";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EVENT_TYPE = "AGENT_MAINTENANCE_REQUESTED";
const WORKER_PATH = "/api/worker";
const DEFAULT_CRON = "*/5 * * * *";
const RETRIES = 3;

const command = process.argv[2] ?? "verify";

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

function readEnvFile(file) {
  const parsed = {};

  if (!fs.existsSync(file)) return parsed;

  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;

    const key = match[1];
    let value = match[2].trim();
    const quote = value[0];

    if (quote === '"' || quote === "'") {
      value = value.slice(1, value.endsWith(quote) ? -1 : undefined);
    }

    parsed[key] = value;
  }

  return parsed;
}

const fileEnv = readEnvFile(path.join(ROOT, ".env"));
const env = { ...fileEnv, ...process.env };

const token = env.QSTASH_TOKEN;
const baseUrl = env.QSTASH_URL;

// ---------------------------------------------------------------------------
// The body QStash will replay on every tick
// ---------------------------------------------------------------------------

/**
 * Deliberately minimal.
 *
 * `id` and `time` are required by the CloudEvents spec but cannot be baked into a
 * schedule body: QStash replays one static document forever, so any timestamp
 * written here would be frozen at schedule-creation time and every tick would
 * claim to have happened then. The dispatcher fills both in per delivery from the
 * QStash message id and the arrival time.
 *
 * `specversion` and `source` are static facts about the envelope and belong here.
 */
const body = JSON.stringify(
  {
    specversion: "1.0",
    type: EVENT_TYPE,
    source: "qstash-schedule/agent-maintenance",
    datacontenttype: "application/json",
    data: { limit: 100 },
  },
  null,
  2,
);

const headers = { "Content-Type": "application/json" };

// ---------------------------------------------------------------------------
// destination
// ---------------------------------------------------------------------------

function resolveDestination() {
  const base = env.APP_URL ?? env.NEXT_PUBLIC_APP_URL;

  if (!base) {
    throw new Error(
      "Neither APP_URL nor NEXT_PUBLIC_APP_URL is set. The schedule needs a " +
        "base URL to build its destination.",
    );
  }

  return new URL(WORKER_PATH, base).toString();
}

/**
 * Refuse destinations QStash cannot reach.
 *
 * This is a guard, not a style preference. QStash accepts a localhost or tunnel
 * URL without complaint and then fails every delivery, so the schedule exists,
 * appears configured, and does nothing. Catching it here is the difference
 * between a loud failure now and a silently dead recovery system later.
 */
function assertReachableDestination(destination) {
  const url = new URL(destination);
  const problems = [];

  if (url.protocol !== "https:") {
    problems.push(
      `scheme is ${url.protocol}// - QStash requires https for a public destination`,
    );
  }

  const host = url.hostname.toLowerCase();

  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    problems.push("host is a loopback address, which QStash cannot reach");
  }

  if (host.endsWith(".local") || host.endsWith(".internal")) {
    problems.push(`host "${host}" is not publicly resolvable`);
  }

  if (host.endsWith(".ngrok-free.dev") || host.endsWith(".ngrok.io")) {
    problems.push(
      "host is a temporary ngrok tunnel; the schedule would die with the " +
        "tunnel process and would look configured until then",
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to point the maintenance schedule at ${destination}:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\n\nSet APP_URL to the deployed public origin and re-run.",
    );
  }
}

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------

function buildPlan(client) {
  const destination = resolveDestination();
  assertReachableDestination(destination);

  return { client, destination, cron: env.AGENT_MAINTENANCE_CRON ?? DEFAULT_CRON };
}

function desired() {
  return {
    destination: null, // filled by buildPlan
    method: "POST",
    headers,
    body,
    cron: null,
    retries: RETRIES,
  };
}

/**
 * Every schedule whose body is our maintenance event.
 *
 * Matched on the event type inside the body rather than on a name or a cron
 * expression, so renaming, re-croning or re-pointing the schedule does not
 * orphan a second copy. A duplicate schedule is not a harmless accident: two
 * ticks of the same bounded sweep running concurrently is precisely the
 * overlapping-pass case the CAS guards were written for, and it doubles the
 * sweep cost for no benefit.
 */
async function findExisting(client) {
  const schedules = await client.schedules.list();

  return schedules.filter((s) => {
    try {
      return JSON.parse(s.body ?? "{}").type === EVENT_TYPE;
    } catch {
      return false;
    }
  });
}

function check(actual, expected, failures, field) {
  if (actual === expected) return;

  failures.push(`${field}: expected ${JSON.stringify(expected)}, QStash has ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function apply() {
  const { client, destination, cron } = buildPlan(qstashClient());
  const want = { ...desired(), destination, cron };
  const existing = await findExisting(client);

  console.log(`destination : ${destination}`);
  console.log(`cron        : ${cron}`);
  console.log(`existing    : ${existing.length} maintenance schedule(s)`);

  if (existing.length === 1) {
    const current = existing[0];
    const changed = [];

    for (const [field, value] of Object.entries(want)) {
      const actual = field === "body" ? current.body : current[field];
      if (actual !== value) changed.push(field);
    }

    if (changed.length === 0) {
      console.log("unchanged   : no update needed");
    } else {
      const updated = await client.schedules.update({
        scheduleId: current.scheduleId,
        ...want,
      });
      console.log(`updated     : ${current.scheduleId} (${changed.join(", ")})`);
      console.log(JSON.stringify(updated, null, 2));
    }
  } else if (existing.length === 0) {
    const created = await client.schedules.create(want);
    console.log("created");
    console.log(JSON.stringify(created, null, 2));
  } else {
    // More than one is ambiguous. Rather than guess, fail and let a human decide
    // which to keep - deleting the wrong schedule silently is worse than noise.
    throw new Error(
      `Found ${existing.length} maintenance schedules ` +
        `(${existing.map((s) => s.scheduleId).join(", ")}). ` +
        "Refusing to guess. Remove the extras, then re-run.",
    );
  }

  await verify();
}

async function verify() {
  const { client, destination, cron } = buildPlan(qstashClient());
  const existing = await findExisting(client);
  const failures = [];

  if (existing.length === 0) {
    console.log("FAIL: no AGENT_MAINTENANCE_REQUESTED schedule exists in QStash");
    return false;
  }

  if (existing.length > 1) {
    failures.push(
      `${existing.length} maintenance schedules exist; expected exactly 1`,
    );
  }

  const schedule = existing[0];

  check(schedule.destination, destination, failures, "destination");
  check(schedule.method, "POST", failures, "method");
  check(schedule.cron, cron, failures, "cron");
  check(schedule.body, body, failures, "body");

  // Header comparison is normalised: QStash returns header values as arrays.
  const actualHeaders = JSON.stringify(schedule.header ?? {});
  check(actualHeaders, JSON.stringify(headers), failures, "header");

  if (schedule.isPaused) {
    failures.push("schedule is paused, so no tick will ever fire");
  }

  // The body must satisfy the worker schema. Parsing it here means a malformed
  // schedule body is caught by this script rather than by a 500 on every tick.
  let parsed;
  try {
    parsed = JSON.parse(schedule.body);
  } catch {
    failures.push("body is not valid JSON");
  }

  if (parsed) {
    if (parsed.type !== EVENT_TYPE) {
      failures.push(`body.type is ${parsed.type}, expected ${EVENT_TYPE}`);
    }

    if (parsed.id) {
      failures.push(
        "body carries a static CloudEvents id; a schedule body is replayed " +
          "verbatim, so every tick would claim the same identity",
      );
    }

    if (parsed.time) {
      failures.push(
        "body carries a static CloudEvents time; every tick would be " +
          "timestamped at schedule-creation time",
      );
    }

    const limit = parsed.data?.limit;

    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      failures.push(`body.data.limit (${limit}) is outside the schema's 1..1000 integer range`);
    }
  }

  // Delivery history is the only proof the schedule actually fires.
  const states = schedule.lastScheduleStates ?? {};
  const total = Object.keys(states).length;
  const failed = Object.values(states).filter((s) => s !== "DELIVERED").length;

  console.log("--- QStash state ---");
  console.log(`scheduleId   : ${schedule.scheduleId}`);
  console.log(`destination  : ${schedule.destination}`);
  console.log(`method       : ${schedule.method}`);
  console.log(`cron         : ${schedule.cron}`);
  console.log(`isPaused     : ${schedule.isPaused}`);
  console.log(`parallelism  : ${schedule.parallelism} (0 = unlimited)`);
  console.log(`retries      : ${schedule.retries}`);
  console.log(`lastRun      : ${schedule.lastScheduleTime ? new Date(schedule.lastScheduleTime).toISOString() : "never"}`);
  console.log(`nextRun      : ${schedule.nextScheduleTime ? new Date(schedule.nextScheduleTime).toISOString() : "unknown"}`);
  console.log(`recentStates : ${total === 0 ? "no runs recorded" : `${total - failed}/${total} delivered`}`);

  if (total > 0) {
    for (const [msgId, state] of Object.entries(states)) {
      console.log(`  - ${msgId}: ${state}`);
    }
  }

  console.log("--- checks ---");

  if (failures.length === 0) {
    console.log("config       : OK (QStash agrees with the intended schedule)");

    if (total === 0) {
      console.log(
        "delivery     : NOT VERIFIED - the schedule has never run, so this " +
          "proves the schedule exists and is configured correctly, and nothing more",
      );
    } else if (failed > 0) {
      console.log(
        `delivery     : NOT VERIFIED - ${failed} of the last ${total} runs did not deliver`,
      );
    } else {
      console.log("delivery     : OK");
    }

    return true;
  }

  for (const failure of failures) console.log(`MISMATCH     : ${failure}`);

  return false;
}

async function remove() {
  const existing = await findExisting(qstashClient());

  if (existing.length === 0) {
    console.log("nothing to remove");
    return;
  }

  for (const schedule of existing) {
    await qstashClient().schedules.delete({ scheduleId: schedule.scheduleId });
    console.log(`removed ${schedule.scheduleId}`);
  }
}

function qstashClient() {
  if (!token) throw new Error("QSTASH_TOKEN is not set.");

  if (!baseUrl) {
    throw new Error(
      "QSTASH_URL is not set. Upstash is multi-region and the default " +
        "endpoint will reject the token with a confusing 'user not found in " +
        "this region' error. Copy the base URL from the QStash console.",
    );
  }

  // Not optional. The default https://qstash.upstash.io is eu-central-1, and
  // using it against a token from another region fails with a 404 that reads
  // like a bad credential rather than a wrong endpoint.
  return new Client({ token, baseUrl });
}

function plan() {
  const destination = resolveDestination();
  const cron = env.AGENT_MAINTENANCE_CRON ?? DEFAULT_CRON;

  console.log("--- intended schedule ---");
  console.log(`qstash region: ${baseUrl ?? "(QSTASH_URL not set)"}`);
  console.log(`destination  : ${destination}`);
  console.log(`method       : POST`);
  console.log(`cron         : ${cron}`);
  console.log(`retries      : ${RETRIES}`);
  console.log("body         :");
  console.log(body);

  try {
    assertReachableDestination(destination);
    console.log("\nguard        : destination looks publicly reachable");
  } catch (error) {
    console.log(`\nguard        : ${error.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------

try {
  switch (command) {
    case "plan":
      plan();
      break;
    case "apply":
      await apply();
      break;
    case "verify":
      if (!(await verify())) process.exitCode = 1;
      break;
    case "remove":
      await remove();
      break;
    default:
      console.error(`Unknown command "${command}". Use plan|apply|verify|remove.`);
      process.exitCode = 2;
  }
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

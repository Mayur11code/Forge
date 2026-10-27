// scripts/qstash-domain-maintenance-schedule.mjs
//
// Create, update, and VERIFY the QStash schedule that drives domain deletion outbox maintenance.
//
// Operates against the single /api/worker endpoint with cryptographic Upstash signature verification.
//
// Usage:
//   node scripts/qstash-domain-maintenance-schedule.mjs plan      # dry run, no writes
//   node scripts/qstash-domain-maintenance-schedule.mjs apply     # create or update in live QStash
//   node scripts/qstash-domain-maintenance-schedule.mjs verify    # read-only check against live QStash
//   node scripts/qstash-domain-maintenance-schedule.mjs remove    # delete the schedule
//
// Env:
//   DOMAIN_MAINTENANCE_CRON    override cron expression (default "* * * * *")
//   APP_URL                    override base URL (required, must be publicly reachable https://)
//   QSTASH_TOKEN               QStash Bearer token
//   QSTASH_URL                 QStash regional API URL

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "@upstash/qstash";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EVENT_TYPE = "DOMAIN_MAINTENANCE_REQUESTED";
const WORKER_PATH = "/api/worker";
const DEFAULT_CRON = "* * * * *";
const RETRIES = 3;

const command = process.argv[2] ?? "verify";

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

const body = JSON.stringify(
  {
    specversion: "1.0",
    type: EVENT_TYPE,
    source: "qstash-schedule/domain-maintenance",
    datacontenttype: "application/json",
    data: { limit: 50 },
  },
  null,
  2
);

const headers = { "Content-Type": "application/json" };

function resolveDestination() {
  const base = env.APP_URL ?? env.NEXT_PUBLIC_APP_URL;
  if (!base) {
    throw new Error(
      "Neither APP_URL nor NEXT_PUBLIC_APP_URL is set. The schedule needs a base URL to build its destination."
    );
  }
  return new URL(WORKER_PATH, base).toString();
}

function assertReachableDestination(destination) {
  const url = new URL(destination);
  const problems = [];
  const warnings = [];

  if (url.protocol !== "https:") {
    problems.push(`scheme is ${url.protocol}// - QStash requires https for a public destination`);
  }

  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
    problems.push("host is a loopback address, which QStash cannot reach");
  }

  if (host.endsWith(".local") || host.endsWith(".internal")) {
    problems.push(`host "${host}" is not publicly resolvable`);
  }

  if (problems.length > 0) {
    throw new Error(
      `Refusing to point the maintenance schedule at ${destination}:\n` +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\n\nSet APP_URL to the deployed public origin and re-run."
    );
  }

  return warnings;
}

function buildPlan(client) {
  const destination = resolveDestination();
  const warnings = assertReachableDestination(destination);

  return {
    client,
    destination,
    cron: env.DOMAIN_MAINTENANCE_CRON ?? DEFAULT_CRON,
    warnings,
  };
}

function desired() {
  return {
    destination: null,
    method: "POST",
    headers,
    body,
    cron: null,
    retries: RETRIES,
  };
}

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

function qstashClient() {
  if (!token) throw new Error("QSTASH_TOKEN is not set.");
  if (!baseUrl) {
    throw new Error("QSTASH_URL is not set.");
  }
  return new Client({ token, baseUrl });
}

function plan() {
  const destination = resolveDestination();
  const cron = env.DOMAIN_MAINTENANCE_CRON ?? DEFAULT_CRON;

  console.log("--- intended schedule ---");
  console.log(`qstash region: ${baseUrl ?? "(QSTASH_URL not set)"}`);
  console.log(`destination  : ${destination}`);
  console.log(`method       : POST`);
  console.log(`cron         : ${cron}`);
  console.log(`retries      : ${RETRIES}`);
  console.log("body         :");
  console.log(body);

  try {
    const warnings = assertReachableDestination(destination);
    if (warnings.length === 0) {
      console.log("\nguard        : destination looks publicly reachable");
    }
  } catch (error) {
    console.log(`\nguard        : ${error.message}`);
    process.exitCode = 1;
  }
}

async function apply() {
  const { client, destination, cron, warnings } = buildPlan(qstashClient());
  const want = { ...desired(), destination, cron };
  const existing = await findExisting(client);

  console.log(`destination : ${destination}`);
  console.log(`cron        : ${cron}`);
  console.log(`existing    : ${existing.length} domain maintenance schedule(s)`);

  for (const warning of warnings) {
    console.log(`\nWARNING     : ${warning}\n`);
  }

  if (existing.length === 1) {
    const current = existing[0];
    const updated = await client.schedules.update({
      scheduleId: current.scheduleId,
      ...want,
    });
    console.log(`updated     : ${current.scheduleId}`);
    console.log(JSON.stringify(updated, null, 2));
  } else if (existing.length === 0) {
    const created = await client.schedules.create(want);
    console.log("created");
    console.log(JSON.stringify(created, null, 2));
  } else {
    throw new Error(
      `Found ${existing.length} domain maintenance schedules. Refusing to guess. Remove the extras, then re-run.`
    );
  }

  await verify();
}

async function verify() {
  const { client, destination, cron, warnings } = buildPlan(qstashClient());
  const existing = await findExisting(client);
  const failures = [];

  for (const warning of warnings) {
    console.log(`WARNING     : ${warning}`);
  }

  if (existing.length === 0) {
    console.log("FAIL: no DOMAIN_MAINTENANCE_REQUESTED schedule exists in QStash");
    return false;
  }

  const schedule = existing[0];
  check(schedule.destination, destination, failures, "destination");
  check(schedule.method, "POST", failures, "method");
  check(schedule.cron, cron, failures, "cron");
  check(schedule.body, body, failures, "body");

  if (schedule.isPaused) {
    failures.push("schedule is paused, so no tick will ever fire");
  }

  console.log("--- checks ---");
  if (failures.length === 0) {
    console.log("config       : OK (QStash agrees with the intended schedule)");
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

# Runtime Dependency Security Remediation — Final Report

**Date:** 2026-10-20 (amended 2026-10-20 — Next.js 16.4.1 advisory reconciliation)
**Scope:** Targeted runtime-dependency security remediation following the Security Audit Follow-up (8 gaps).
**Repo:** `C:\Users\Mayur\Desktop\Forge\Forge` (app root `forge/`, git root one level up)
**Branch:** `feat/37.1-action-capability-catalog` @ `3e4998a`
**Status:** Working-tree only. **Nothing staged, nothing committed.** Assignment 37.12 was **not** implemented.

> **Amendment note.** The first revision of this report targeted `next@16.3.8` and asserted it
> "cleared all critical/high runtime advisories" based on `npm audit`. That claim was **wrong**: the
> local `npm audit` advisory sink does not yet carry the Next.js advisories published
> **2026-10-14** (GHSA-673q-mjm6-r5xr, GHSA-2464-fhr4-w9xw, GHSA-p3m5-59mp-jv5r), and `16.3.8`
> lies inside their affected range `16.0.0–16.4.0`. The target has been raised to **`next@16.4.1`**
> (the advisory-patched release) with a documented config mitigation for a route-structure
> incompatibility. See §9.

---

## 1. Objective & constraints

Remediate flagged runtime-dependency advisories via **targeted upgrades only**, verify with the
full test/type/lint suite, and report exact before/after versions, advisories, commands, and any
residual findings or regressions — without weakening tests, changing application security logic,
or blindly running `npm audit fix`.

Hard constraints observed throughout:
- No staging / commit / reset / clean / discard.
- No migrations, schema push, shared/prod DB writes, live workflow execution, real-model calls,
  destructive tests, credential rotation, or git-history rewrite.
- No redesign of evaluator/resolver/locking/queueing; no change to application security logic.
- No forced resolutions without explanation. Unresolved behavioral regressions are **reported**,
  not hidden by weakening tests.

---

## 2. Changes applied

### 2.1 `forge/package.json` — direct dependency bumps

| Package | Before | After | Rationale |
|---|---|---|---|
| `next` | `16.1.3` | **`16.4.1`** | Clears the October 14 advisories (GHSA-673q-mjm6-r5xr, GHSA-2464-fhr4-w9xw, GHSA-p3m5-59mp-jv5r) — patched at 16.4.1 / 15.5.28. Also clears the earlier SSRF/cache/middleware range. See §9. |
| `next-auth` | `^5.0.0-beta.30` | **`^5.0.0-beta.32`** | Auth.js fail-open / homoglyph / getToken / PKCE advisories. |
| `@auth/prisma-adapter` | `^2.11.1` | **`^2.11.3`** | Pins patched `@auth/core@0.41.3`. |
| `html-to-text` | `^10.0.0` | **`^10.0.1`** | Patched release. |
| `eslint-config-next` | `16.1.3` | `16.1.3` (unchanged) | Dev-only, not a runtime finding; intentionally left as-is. |

### 2.2 `forge/package.json` — `overrides` (new block)

| Override | Pin | Rationale |
|---|---|---|
| `effect` | `^3.22.3` | Builds back to the flagged UploadThing chain; patched ≥ 3.20.0 (CVE-2026-32887 / GHSA-38f7-945m-qr2g). |
| `deepmerge-ts` | `^8.0.1` | Patched at 8.0.0 (GHSA-ggr8-5vv4-36mx). |
| `defu` | `^6.1.7` | Patched > 6.1.4 (GHSA-737v-mqg7-c878). |
| `eslint-plugin-react-hooks` | `7.0.1` | Keeps nested copy under `eslint-config-next` consistent (lint-only). |

### 2.3 Resolved dependency versions (installed)

`next 16.4.1` · `next-auth 5.0.0-beta.32` · `@auth/core 0.41.3` · `@auth/prisma-adapter 2.11.3` ·
`uploadthing 7.7.4` · `@uploadthing/react 7.3.3` · `@uploadthing/shared 7.1.10` · `html-to-text 10.0.1` ·
`effect 3.22.3` · `deepmerge-ts 8.0.2` · `defu 6.1.7` · `eslint-plugin-react-hooks 7.0.1` ·
`sharp 0.35.5` (all `@img/sharp-*` / `@img/sharp-libvips-*` platform packages at 0.35.5 / 1.3.4).

`@effect/platform@0.90.3` peer `effect ^3.17.7` is satisfied by `3.22.3`. `uploadthing@7.7.4` is the
latest release and still declares a vulnerable `effect` range, which the override neutralizes at
the resolved-instance level.

### 2.4 Regression fix introduced by the prior S3 security work

`forge/src/app/api/stream-audit/route.ts`

```diff
-export const runtime = 'edge';
+export const runtime = 'nodejs';
```

The S3 hardening (prior session) added an `auth()` gate to this route. `auth()` transitively
imports `PrismaAdapter` and `src/lib/prisma/db` (Node `crypto`), which **cannot run on the Edge
runtime**. The route was `runtime = 'edge'`, so once the build got past route analysis it failed at
page-data collection with:

```
The edge runtime does not support Node.js 'crypto' module.
```

Changing the runtime target to `nodejs` is a **runtime-target change only**; the authentication
gate is preserved verbatim. No security logic was weakened. This was a genuine regression from the
security work, now fixed.

---

## 3. Verification

Commands run in `forge/` with `node v22.18.0` / `npm 10.9.3`.

| Check | Command | Result |
|---|---|---|
| Type check | `.\node_modules\.bin\tsc.cmd --noEmit` | **exit 0** |
| Full tests | `.\node_modules\.bin\jest.cmd --no-coverage` | **64/64 suites, 1142/1142 tests** |
| Focused security/workflow/agent | `jest src/tests/security src/tests/agent/worker-auth.test.ts src/tests/agent/session-read.test.ts src/tests/workflow` | **24/24 suites, 419/419** |
| Lint | `.\node_modules\.bin\eslint.cmd .` | **exit 0** (0 errors, 32 pre-existing warnings) |
| Dependency audit | `npm audit` | **39 total — 0 critical** (see §4) |
| Prisma schema | `.\node_modules\.bin\prisma.cmd validate` | valid |

No test was modified to pass; the full green suite reflects the pre-existing 64/1142 baseline.

### 3.1 Pre-change hashes (rollback reference)

| File | SHA256 |
|---|---|
| `package-lock.json` | `25295D1B024C3C2617AAE05C10F65C93DC6638896FA7ED949E4E921A784D50C0` |
| `package.json` | `ACF785932E904BCB7FD972D6753208278FD89C0DE11C9D5D3E1679F8A2061235` |

---

## 4. Audit result — before / after

| Severity | Before | After |
|---|---|---|
| Critical | 4 | **0** |
| High | 31 | 20 |
| Moderate | 14 | 13 |
| Low | 6 | 6 |
| **Total** | **55** | **39** |

**All 11 in-scope packages are now clear** (`next`, `next-auth`, `@auth/core`,
`@auth/prisma-adapter`, `uploadthing`, `@uploadthing/react`, `@uploadthing/shared`, `html-to-text`,
`effect`, `deepmerge-ts`, `defu`) — verified programmatically against the final audit JSON.

> **Caveat (important).** These `npm audit` counts do **not** include the Next.js advisories
> published 2026-10-14; the audit sink carried no `next` entry at all. The counts therefore do not
> by themselves establish the security posture. The authoritative coverage statement is in §9,
> derived from the upstream advisories + version ranges, not from the audit summary.

### 4.1 Resolved advisories (scope)

- **effect** — patched ≥ 3.20.0 · CVE-2026-32887 · GHSA-38f7-945m-qr2g
- **deepmerge-ts** — patched 8.0.0 · GHSA-ggr8-5vv4-36mx
- **defu** — patched > 6.1.4 · GHSA-737v-mqg7-c878
- **@auth/core 0.41.3 / next-auth 5.0.0-beta.32** — Auth.js fail-open GHSA-8fpg-xm3f-6cx3,
  homoglyph GHSA-7rqj-j65f-68wh, getToken GHSA-xmf8-cvqr-rfgj, PKCE GHSA-x445-f3h2-j279
- **next 16.4.1** — clears both the earlier SSRF/cache-poisoning/middleware-bypass range
  (`9.3.4-canary.0 – 16.3.7`) **and** the October 14 range `16.0.0 – 16.4.0` (§9)

### 4.2 Residual findings (39) — none reachable at runtime in this app

| Package | Severity | Path | Reachability |
|---|---|---|---|
| `prisma` | high | `@prisma/dev`, `mysql2` | **devDependency** (CLI). App uses Postgres via `@prisma/adapter-pg`; `mysql2` is never loaded at runtime. |
| `eslint-config-next` | high | `@next/eslint-plugin-next` | **devDependency** (lint only). |
| `resend` | moderate | `svix` | Runtime dep; no patched `resend` release yet. Reported as residual. |
| `@ai-sdk/google`, `@ai-sdk/react`, `ai` | low | `@ai-sdk/provider-utils`, `@ai-sdk/gateway` | Low; no patched release. |
| `postcss`, `browserslist`, `sharp`, `lodash`, `chevrotain`, transitive `axios`/`form-data`/`js-yaml` | various | build/tooling chain | Not runtime-applicable. |

**No critical or high runtime findings remain** per `npm audit`; the two high findings (`prisma`,
`eslint-config-next`) are dev/CLI-scoped, and the one runtime-visible moderate (`resend`) has no
fixed upstream version and is reported rather than force-resolved. See §9 for the authoritative
Next.js coverage statement that supersedes the audit summary.

---

## 5. Build verification & pre-existing blockers

`npm run build` (= `prisma generate && next build`) was exercised repeatedly. Findings:

1. **Next 16.4 strict route matching vs the `@modal/new` parallel route (mitigated).** Next 16.4
   enabled *strict route matching by default*. The app's pre-existing
   `app/org/[orgId]/projects/@modal/new/page.tsx` intercepts `/org/[orgId]/projects/new`, but the
   sibling `children` slot has no matching page or `default.tsx`, so strict matching rejects it:

   ```
   Error: Parallel route slots cannot render the same URLs
   - /org/[orgId]/projects/new is missing a matching page or default.tsx in children
   Error: Unmatched app pages
   - app/org/[orgId]/projects/@modal/new/page.tsx
   ```

   **Verified empirically: this regression is present in `next@16.4.1` itself**, not only 16.4.2
   (the first revision of this report mis-attributed it to 16.4.2). Mitigated with the Next-documented
   escape hatch in `forge/next.config.ts`:

   ```ts
   deprecated: { looseRouteMatching: true }
   ```

   This is a **config-only** change (no application/security logic touched) that restores pre-16.4
   route behavior. The underlying route structure should be corrected separately. See §9.3.

2. **`/api/stream-audit` Edge-runtime failure (fixed — §2.4).** Resolved by `runtime = 'nodejs'`.

3. **Pinecone production-secret gate (pre-existing, environmental).** With `looseRouteMatching` set,
   the build compiles, passes TypeScript, and reaches page-data collection, where it stops at:

   ```
   Error: Failed to collect configuration for /api/chat
     [cause]: CRITICAL FAILURE: Pinecone environment configuration is missing or malformed.
       at module evaluation (src/lib/vector/client.ts:13:9)
   ```

   `src/lib/vector/client.ts:8` selects `PINECONE_API_KEY_PROD` / `PINECONE_INDEX_PROD` when
   `NODE_ENV`/`VERCEL_ENV` is production. `next build` forces production, and the local `.env`
   defines only the `_DEV` pair. `.env.example` explicitly documents the `_PROD` vars as required
   in production. **`client.ts` and every failing route are unmodified from HEAD** (`git status`
   clean for them) — this is a **pre-existing deployment-secret prerequisite**, not a regression
   from any upgrade. A production build has always required these secrets.

Build outcome: **code compiles, TypeScript passes**; page-data collection is blocked solely by the
absent production Pinecone secrets. This gate could not be cleared without writing real production
secrets (out of scope / prohibited).

---

## 6. Files changed

**Modified (working tree):** `package.json`, `package-lock.json`, `next.config.ts`
(`deprecated.looseRouteMatching`), `src/app/api/stream-audit/route.ts` (runtime target) + all
Security-Audit-Follow-up edits (attachments, razorpay create-order/webhook, triage, test-run,
uploadthing core/delete, agent session route, workflow-run action, tool-execution-service, seed,
worker, and the integration/plumbing files).

**New (untracked):** `src/lib/security/public-error.ts`, `src/lib/security/seed-password.ts`,
`src/tests/security/`, `src/tests/workflow/{trigger-tenant-scope,workflow-run-boundary-scope}.test.ts`,
`docs/architecture/security/`, `docs/dev-log/2026-10-20-i6-cross-tenant-execution.md`.

`tmp-lockcheck.mjs` (untracked, unrelated) was left untouched.

---

## 7. Open gates & owner actions (unchanged)

- Real-PostgreSQL cross-tenant verification.
- 37.8 migration-applied gate.
- 37.11 real-DB materialization / idempotency gate.
- **S11 credential rotation** — owner action, not remediated here.
- **Production Pinecone secrets** (`PINECONE_API_KEY_PROD` / `PINECONE_INDEX_PROD`) must be present
  in the deploy environment for a production build to complete.

---

## 8. Recommendation

- Stage and commit `package.json` + `package-lock.json` + `next.config.ts` + the `stream-audit`
  runtime fix together with the Security Audit Follow-up changes once reviewed.
- Track the residual `resend`/`svix` moderate finding for the next upstream release.
- **Correct the `@modal/new` parallel-route structure** so `deprecated.looseRouteMatching` can be
  removed; the current flag is a sanctioned bridge, not a permanent state.
- Keep `next` at ≥ 16.4.1 (or 15.5.28 on the 15.x line) for the October 14 advisories.

---

## 9. Next.js advisory reconciliation (2026-10-14 advisories)

### 9.1 Why `npm audit` did not report them

`npm audit` uses the GitHub npm advisory (bulk) endpoint. At the time of every run in this task the
sink carried **no `next` entry** — the audit JSON had a `vulnerabilities` map with no `next` key,
and `sharp` was likewise absent. The October 14 advisories were therefore invisible to the summary,
which is why `16.3.8` *appeared* clear. **The audit summary is not authoritative here**; the ranges
below are taken from the published advisories.

### 9.2 The three advisories — ranges, patches, applicability

| ID | Severity | Affected (Next.js) | Patched | Applies to this app? |
|---|---|---|---|---|
| **GHSA-673q-mjm6-r5xr** — RCE, `use cache` returning typed arrays | Critical (9.5) | `>=16.0.0 <=16.4.0` | `16.4.1` | **No, by configuration** — no `use cache` / Cache Components anywhere in `src/` (grep: zero matches). |
| **GHSA-2464-fhr4-w9xw** / CVE-2026-96889 — RCE, Image Optimization SVG (librsvg via `sharp`) | Critical (9.5) | `>=10.0.0 <=15.5.27`, `>16.0.0 <=16.4.0` | `15.5.28`, `16.4.1` | **No** — no `dangerouslyAllowSVG`, no `next/image` import, no `next/og` in `src/`. Resilience in depth: `sharp` is already `0.35.5`, which the advisory names as the workaround (librsvg 2.63.2+). |
| **GHSA-p3m5-59mp-jv5r** — DoS, App Router Server Actions | High (8.2) | `>=13.0.0 <=15.5.27`, `>=16.0.0 <=16.4.0` | `15.5.28`, `16.4.1` | **Yes** — the app defines Server Actions (`"use server"` in 9 modules under `src/app/actions/**` and `src/app/org/**/action.ts`). This is the one genuinely-applicable advisory. |

Version note: the image advisory writes its 16.x range as `>16.0.0`, the other two as `>=16.0.0`;
treating `16.0.0` as affected is the conservative reading.

**Regardless of configuration, `16.3.8` sits inside all three affected ranges.** Configuration
reduces exploitability of two of them, but the version-range coverage claim in the first revision of
this report was incorrect. Raising to `16.4.1` removes the dependency on "not reachable by config".

### 9.3 `next@16.4.1` route-compatibility test (empirical)

The first revision claimed strict route matching arrived in 16.4.2. **That was wrong.** With
`next@16.4.1` installed and no config mitigation, `next build` failed at route analysis with:

```
⚠ Strict route matching is enabled by default. ...
Error: Turbopack build failed with 2 errors:
./src/app/org/[orgId]/projects/layout.tsx
Error: Parallel route slots cannot render the same URLs
- /org/[orgId]/projects/new is missing a matching page or default.tsx in children
./src/app/org/[orgId]/projects/@modal/new/page.tsx
Error: Unmatched app pages
- app/org/[orgId]/projects/@modal/new/page.tsx
```

So **16.4.1 carries the same strict-matching regression as 16.4.2.** With
`deprecated.looseRouteMatching: true` added to `next.config.ts`, the build proceeds past route
analysis (`✓ Compiled successfully`, `Finished TypeScript`) and stops only at the pre-existing
Pinecone production-secret gate (§5.3).

### 9.4 Decision

Keep **`next@16.4.1`** (advisory-patched) + **`deprecated.looseRouteMatching: true`** (config-only,
Next-sanctioned bridge that preserves current route behavior). No security logic changed, no test
weakened, no unrelated upgrade introduced. Not moved to 16.4.2 (no security benefit for this app;
same route situation). The underlying `@modal/new` structure is flagged for a proper fix.

### 9.5 Final Next.js advisory status

| Advisory | Status after this change |
|---|---|
| GHSA-673q-mjm6-r5xr | **Resolved by version** (`16.4.1` ≥ patch); additionally not applicable by config |
| GHSA-2464-fhr4-w9xw | **Resolved by version** (`16.4.1` ≥ patch) **and** `sharp 0.35.5` ≥ workaround |
| GHSA-p3m5-59mp-jv5r | **Resolved by version** (`16.4.1` ≥ patch) — was the genuinely-applicable one |
| earlier `next` range (`… – 16.3.7`) | Still covered (`16.4.1` > 16.3.7) |

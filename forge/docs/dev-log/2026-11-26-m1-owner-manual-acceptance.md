# 2026-11-26 — Milestone M1 Owner Manual Acceptance & M2 Transition

**Scope.** Record the authoritative owner manual acceptance for Milestone M1 (Identity, Accounts & Organizations, assignments `FC-002` through `FC-007`), document cross-tenant access-control verification, formally record the deliberate owner-approved deferral of live Resend external email provider delivery, reconcile the canonical product completion tracker, and establish the formal transition baseline to Milestone M2 (Projects and Task Management, starting with `FC-008`).

---

## 1. Owner Manual Acceptance Results

Following end-to-end automated verification across Level E3 PostgreSQL concurrency suites (`src/tests/auth/m1-concurrency.realdb.test.ts`) and Playwright browser suites (`src/tests/e2e/m1-journeys.spec.ts`), the repository owner conducted an independent manual inspection of the running Forge application on local infrastructure.

### Overall Milestone M1 Owner Disposition: **PASS (with Documented Email-Delivery Exception)**

| Assignment ID | Capability | Owner Result | Verification Summary & Evidence |
| :--- | :--- | :---: | :--- |
| **FC-002** | Registration & Authentication | **PASS** | Founder registration at `/signup`, password validation (&ge; 8 characters), bcryptjs hashing, automatic NextAuth session establishment, and redirection to onboarding verified manually. |
| **FC-003** | First-Time Organization Onboarding | **PASS** | Onboarding form at `/onboarding`, reactive slug preview generation, atomic organization + founder `ADMIN` membership + default project creation, and immediate workspace dashboard redirection verified manually. Transaction timeout resolution and authoritative idempotency keys verified under replay. |
| **FC-004** | Multi-Organization Selector & Header Switcher | **PASS** | Workspace selector at `/select-org` renders all user memberships with accurate project/member counters. Interactive header `OrgSwitcher` switches active tenant context seamlessly. Z-index stacking context resolved (dropdown renders above project tiles). |
| **FC-005** | Member Role Management & Last-Admin Protection | **PASS** | Team members table at `/org/[slug]/members` displays members and roles. Sole administrator cannot be demoted or removed; action controls are disabled in the UI and serialized via PostgreSQL row-level locks (`SELECT id FROM "Organization" WHERE id = $1 FOR UPDATE`). |
| **FC-006** | Invitation Application Flow | **PASS** *(Provider Delivery Deferred)* | Application-side invitation token generation, 24-hour expiration lifecycle, recipient email mismatch guards, and atomic invitation acceptance via `/invite/[token]` verified end-to-end. External email provider delivery is explicitly deferred (see Section 2). |
| **FC-007** | Profile & Account Settings Completeness | **PASS** | User profile form at `/org/[slug]/user/profile` allows updating display name and password with validation and instant UI feedback. Persisted correctly in database. |

### Cross-Organization Tenant Boundary Checks: **PASS**
- **Unauthenticated Redirection:** Direct navigation to `/org/[slug]/dashboard`, `/org/[slug]/members`, or `/select-org` without an active session redirects callers to `/login`.
- **Tenant Isolation Enforcement:** A user authenticated in Organization A attempting to access Organization B's routes or mutate Organization B's memberships is denied via `getOrgAccess` authorization checks (HTTP 403 / 404).

---

## 2. Explicit Preservation of Resend Email Provider Deferral

This is a **deliberate owner-approved deferral**, not a claim of successful external email delivery.

### 2.1 Verified Application-Side Mechanics
The application-side invitation creation, storage, and acceptance flows are fully implemented and verified:
1. High-entropy cryptographically secure tokens are generated via `crypto.randomUUID()`.
2. Invitations are persisted in PostgreSQL with a strict 24-hour expiration (`expiresAt`) and status `PENDING`.
3. The acceptance route (`/invite/[token]`) validates token existence, checks expiration status, enforces recipient email matching, commits membership inside an atomic transaction, marks the invitation `ACCEPTED`, and redirects callers to the organization workspace dashboard.

### 2.2 Live Provider Test Finding & Sandbox Boundary
During live Resend API verification using `scripts/send-live-invitation-test.ts` with the explicitly authorized target `mayurnanda9857@gmail.com`:
- **Sender Used:** `Forge <onboarding@resend.dev>`
- **Target Recipient:** `mayurnanda9857@gmail.com`
- **Provider Result:** HTTP 403 Validation Error:
  ```json
  {
    "message": "You can only send testing emails to your own email address (mayurnanda45@gmail.com). To send emails to other recipients, please verify a domain at resend.com/domains, and change the `from` address to an email using this domain.",
    "name": "validation_error",
    "statusCode": 403
  }
  ```
- **Root Cause:** The configured API key belongs to a free Resend sandbox account registered to `mayurnanda45@gmail.com`. Under Resend sandbox rules, emails sent from `onboarding@resend.dev` can only be delivered to the account owner's email address (`mayurnanda45@gmail.com`). Delivering to `mayurnanda9857@gmail.com` requires a verified custom sending domain (e.g., `resend.com/domains`) and an authorized `from` address.
- **Delivery Fact:** No successful email delivery or mailbox receipt has been verified for `mayurnanda9857@gmail.com`.

### 2.3 Explicit Owner Directive
1. The repository owner reviewed the provider error and explicitly chose to **postpone custom domain verification and email retesting** until a later milestone.
2. In strict compliance with UPPR Rev 4.1 security and recipient constraints:
   - **No emails were sent to any alternative address.**
   - **No additional email tests shall be initiated** until the owner explicitly provisions a verified custom domain and resumes this verification.
3. **Tracking Discipline:** Assignment `FC-006` is **not marked fully complete**; it is tracked with status `PARTIAL (App Flow Owner-Accepted; Resend Delivery Deferred)`.
4. **Downstream Traceability:** Assignment `FC-032` (In-App Notification Feed & Delivery Preferences in Milestone M8) depends directly on `FC-006`. This outstanding provider delivery work remains visibly documented and will be reconciled during M8.

---

## 3. Engineering Hardening & Automated Verification Evidence

Before owner manual inspection, the following automated engineering verifications were achieved on the repository:

### 3.1 PostgreSQL Concurrency & Mutex Serialization (Level E3)
- **Suite:** `src/tests/auth/m1-concurrency.realdb.test.ts`
- **Target:** Remote Neon PostgreSQL (`ep-muddy-water-ah607io6-pooler.c-3.us-east-1.aws.neon.tech`)
- **Results:** 7 passed, 0 failed (100% green).
  - *Idempotency Replay:* Returns existing record without duplicate project or task creation.
  - *Multi-Org Support:* User can create multiple distinct organizations with unique keys.
  - *Test A (Simultaneous Demotions):* Mutex lock serializes concurrent updates; exactly 1 admin remains.
  - *Test B (Simultaneous Removals):* Mutex lock serializes concurrent removals; exactly 1 admin remains.
  - *Test C (Mixed Demotion/Removal):* Serialized safely; organization is never left admin-less.
  - *Test D (Non-Admin Rejection):* Member/Manager caller attempts rejected with 403 Forbidden.
  - *Test E (Cross-Tenant Rejection):* Admin from Org A cannot mutate Org B membership.

### 3.2 Playwright Browser End-to-End Acceptance
- **Suite:** `src/tests/e2e/m1-journeys.spec.ts`
- **Target:** Local Next.js dev server on `http://localhost:3000` with Chromium
- **Results:** 7 passed, 0 failed (100% green, runtime 2.7m).
  - `PW-M1-01`: Fresh founder onboarding (`/signup` &rarr; session &rarr; `/onboarding` &rarr; dashboard).
  - `PW-M1-02`: Organization creation form resubmission idempotency.
  - `PW-M1-03`: Multi-organization selector (`/select-org`) and header switcher (`OrgSwitcher`).
  - `PW-M1-04`: Team member management and last-admin action menu protection.
  - `PW-M1-05`: Team invitation acceptance journey (`/invite/[token]` &rarr; registration &rarr; member access).
  - `PW-M1-06`: Profile settings management (name and password update).
  - `PW-M1-07`: Access-control negative boundary routes.

### 3.3 Quality Gates & Build Verification
- **Jest Unit & Integration:** 129 test suites passed, 2,025 tests passed (`npm test`).
- **TypeScript:** Strict typecheck passed with zero errors (`npx tsc --noEmit`).
- **ESLint:** Strict lint passed with zero errors (`npm run lint`).
- **Production Build:** Next.js production build compiled and optimized 20 static and dynamic routes with zero errors (`npm run build`).

---

## 4. Final Disposition & Milestone M1 → M2 Transition

```text
Milestone M1 Status:      ACCEPTED (Owner Manual Acceptance Passed with Documented Resend Exception)
Resend Provider Delivery: EXPLICITLY DEFERRED (Awaiting custom domain verification by owner)
Next Active Milestone:    M2 — Projects and Task Management
First M2 Assignment:      FC-008 — Project Lifecycle: Edit, Archive & Delete
Direct Dependency:        FC-003 (Owner Accepted)
Directly Unblocks:        FC-009 (Interactive Task Lifecycle & Status Transitions)
```

1. **Owner manual acceptance:** Completed and passed for all customer-facing M1 user journeys (`FC-002`, `FC-003`, `FC-004`, `FC-005`, `FC-007`).
2. **Resend provider delivery:** Explicitly deferred by owner directive; no alternative delivery attempted.
3. **Milestone M1 acceptance:** Owner-approved with documented email delivery exception.
4. **Transition:** The repository is fully prepared and authorized to begin Milestone M2.
5. **Next active assignment:** `FC-008` (Project Lifecycle: Edit, Archive & Delete).

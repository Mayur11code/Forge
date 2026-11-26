# Documentation Archive

This directory preserves historical engineering records, phase reports, completed audits, and retired milestone trackers.

> [!NOTE]
> **Active Product Development:**
> For all current Release 1 assignments, milestone sequencing, acceptance criteria, and status, refer to the single authoritative tracker:
> [PRODUCT_COMPLETION_TRACKER.md](../product/PRODUCT_COMPLETION_TRACKER.md)

---

## Structure

```text
forge/docs/archive/
├── agent/
│   ├── assignments-35-36-audit.md           # Closure audit for Assignments 35 & 36
│   └── roadmap.md                           # Historical agent milestone tracker (2026-09-29)
├── security/
│   └── 2026-10-20-runtime-dependency-remediation.md # Targeted dependency remediation report
└── workflows/
    └── assignment-37/                       # AI Workflow Generation (Phases 37.0 - 37.15, 37.17)
        ├── assignments-37-tracker.md        # Retired 19-phase master execution tracker
        ├── assignments-37-issue-register.md # Initial phase-0 issue register (I1-I6, F1-F6)
        ├── assignments-37-plan.md           # Original implementation plan
        ├── assignments-37-phase-0-audit.md  # Contract reconnaissance audit
        └── assignments-37-phase-37.*.md     # Individual phase verification logs (37.1 - 37.11)
```

## Archive Policy

1. **Immutability:** Historical reports in this directory are preserved verbatim. They record exact point-in-time evidence, test counts, and verified invariants.
2. **Retirement:** Active tracking has moved exclusively to `forge/docs/product/PRODUCT_COMPLETION_TRACKER.md`. No new work items should be tracked or updated within this archive.

## ⚒️ Engineered Forge — Application Root

A multi-tenant, event-driven project execution and DAG workflow orchestration platform.

> [!IMPORTANT]
> **Active Product Development:**
> For all Release 1 capability assignments, milestones, and status, refer to the authoritative:
> [PRODUCT_COMPLETION_TRACKER.md](docs/product/PRODUCT_COMPLETION_TRACKER.md)
>
> Repository-level architecture overview, security invariants, and test metrics are in the [Root README](../README.md).

---

## Quickstart

```bash
npm install
cp .env.example .env        # fill in required keys (DATABASE_URL, AUTH_SECRET)
npx prisma migrate deploy   # apply schema migrations
npx prisma db seed          # optional: seed test credentials
npm run dev                 # run development server at http://localhost:3000
```

## Testing & Verification

```bash
npx prisma generate
npx next typegen
npx tsc --noEmit            # strict compile-time typecheck
npm test                    # 122 suites, 1,978 tests
npm run lint                # ESLint verification
```

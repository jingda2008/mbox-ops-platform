---
name: mbox-commercial-validation
description: Run the M-BOX commercial validation and release gate. Use for requests to audit, test, visually review, load test, fix, publish, deploy, or determine commercial readiness of the M-BOX bar operations platform across guest, reservation, staff, KDS, payment, inventory, SOP, voice, mini-program, Android, iOS, and Cloud Run clients.
---

# M-BOX Commercial Validation

Validate the actual repository and runtime behavior. Do not convert unexecuted store drills or blocked external integrations into passed tests.

## Workflow

1. Read `package.json`, `.github/workflows/ci.yml`, the current `docs/tc-execution-report-*.md`, and `docs/tc-release-blockers-*.csv`.
2. Inspect `git status` and preserve unrelated user changes. Never reset the worktree to prepare a test.
3. Run local tests against isolated JSON state and dedicated ports. Never point mutating browser or load tests at the shared Cloud Run validation database.
4. Run `npm run test:commercial`. This must cover static checks, 213-TC register integrity, unit/integration tests, production build, Playwright browser flows, and the 300-guest k6 model.
5. If a test fails, distinguish a stale assertion from a product defect. Fix product defects at the responsible layer, then rerun the narrow failing test and the complete gate.
6. Visually inspect the guest, server, and manager surfaces at phone and desktop sizes. Check horizontal overflow, hidden actions, keyboard-safe forms, button feedback, and role-specific entry visibility.
7. Run `npm audit --omit=dev --audit-level=high`. Report development-tool findings separately from production dependency findings.
8. Before deployment, verify the version, release evidence, current TC counts, external blockers, and rollback target. Deploy only to validation while any P0/P1 commercial blockers remain.
9. After deployment, perform read-only Cloud Run checks for health, readiness, security headers, guest entry, and responsive page rendering. Do not run payment, refund, inventory, or table mutations against shared validation without an explicit test dataset.

## Required Evidence

- Full `npm run check` file/test totals and build result.
- Playwright test total, failures, screenshots/traces for any defect, and final pass.
- k6 guest count, HTTP request count, failure rate, 5xx count, P95, and P99.
- Current 213-TC passed, unexecuted, blocked, and P0/P1 blocker counts.
- Production dependency audit result.
- Deployed revision, traffic percentage, public URL, health/readiness result, and rollback revision.

## Release Boundaries

- Passing automation is necessary but not sufficient for commercial production.
- Real payment, refund, callback verification, physical POS, printer, headset, camera, WeChat production credentials, disaster recovery, and store drills require external evidence.
- Payment simulation must stay visibly labeled and must never be described as real collection.
- A validation deployment can proceed with documented blockers. A production release cannot proceed while P0/P1 blockers remain.

## Resources

- Run `scripts/run-commercial-gate.sh` for the complete local gate.
- Read `references/release-gate.md` for client, role, load, and deployment coverage.

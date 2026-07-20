# M-BOX 1.0.0-rc.23

## Scope

This validation release adds a repeatable commercial test gate without changing the boundary between validation and production.

## Added

- Playwright browser coverage for guest service requests, staff completion, public reservations, manager visibility, six role entry boundaries, iPhone 14 Pro Max layout, accessibility, and security headers.
- A local k6 model for 300 guest journeys and 60 concurrent virtual users with explicit failure, 5xx, P95, and P99 thresholds.
- A repository-scoped `mbox-commercial-validation` Codex skill and one-command `npm run test:commercial` release gate.
- GitHub Actions browser checks using an isolated API state and Chromium runtime.

## Validation

- Static mini-program verification: 56 files passed.
- Unit and integration tests: 104 files, 756 tests passed.
- Browser flows: 11 tests passed.
- Load baseline: 300 guest journeys, 900 HTTP requests, 0 failures, 0 server 5xx, HTTP P95 23.08ms and P99 32.69ms on the isolated local runtime.
- Production dependency audit: 0 vulnerabilities.

## Commercial boundary

The 213 operating TC baseline remains 147 passed, 50 unexecuted, and 16 blocked. There are still 66 P0/P1 release blockers. This revision may be deployed to the validation environment, but it is not approved for commercial production payment traffic.

import { defineConfig } from 'vitest/config'

// Historical defect reproducers are explicitly invoked, never release acceptance.
// Run only against a disposable local database, as documented in the handoff.
const value = process.env.TEST_NORMALIZED_DATABASE_URL
if (!value) throw new Error('Historical audit requires a disposable local PostgreSQL database')
try {
  const url = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || !url.pathname.startsWith('/mbox_audit_120_') || url.search || url.hash) throw new Error()
} catch {
  throw new Error('Historical audit permits only a disposable local mbox_audit_120_* database')
}

export default defineConfig({
  test: {
    include: ['server/normalized/audit-120-*.repro.ts', 'server/normalized/guest-120-guest-recovery.repro.ts'],
    maxWorkers: 1,
    hookTimeout: 120_000,
  },
})

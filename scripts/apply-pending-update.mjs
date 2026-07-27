/**
 * apply-pending-update.mjs — runs a deferred `npm update` at startup, while
 * Electron is NOT running.
 *
 * WHY THIS EXISTS
 * ---------------
 * The in-app "Update OTForge" button used to run `npm update` directly, from
 * inside the live Electron process. That is unsafe on Windows for a reason
 * that has nothing to do with npm being wrong: the running process holds open
 * file handles on node_modules/electron/dist/electron.exe and
 * dist/resources/default_app.asar, and Windows refuses to rename or replace a
 * file with open handles. npm's package replacement is implemented as a
 * rename, so it aborts with EBUSY (errno -4082) partway through.
 *
 * A partial abort is much worse than a clean failure. It left the tree
 * structurally drifted: the electron shim was reinstalled but its dist/ folder
 * was gone, and electron ended up nested under packages/app/node_modules
 * instead of hoisted to the root. Both `predev` and electron-vite resolve
 * electron from the root, so the app could no longer start at all -- and
 * because this repo intentionally has no lockfile (see .gitignore), npm had no
 * recorded good state to repair against. A plain `npm install` reported
 * success while leaving the install broken; only a full node_modules wipe
 * recovered it. This happened to a live classroom.
 *
 * THE FIX
 * -------
 * Dependency mutation and a running Electron process must never overlap. The
 * update handler now only writes a sentinel file and tells the user to
 * restart; this script consumes that sentinel from `predev`, at which point
 * Electron is not running and npm is free to replace whatever it likes.
 *
 * Ordering matters in `predev`: this runs BEFORE ensure-electron.mjs, so if
 * `npm update` does replace the electron package and drop its binary, the
 * following ensure-electron step downloads it again in the same startup. That
 * makes the previously fatal case routine and self-healing.
 *
 * The sentinel is deleted only after `npm update` succeeds. If the update
 * fails (offline, registry down, proxy), the sentinel stays and the update is
 * retried on the next launch rather than being silently skipped.
 */

import { existsSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Must match PENDING_DEP_UPDATE_FILE in packages/app/src/main/index.ts.
 * Untracked and gitignored, so it can never trip the update handler's own
 * dirty-working-tree guard.
 */
const SENTINEL = join(projectRoot, '.otforge-pending-dep-update')

if (!existsSync(SENTINEL)) {
  // Normal startup: nothing was scheduled, so stay silent and stay fast.
  process.exit(0)
}

console.log('[apply-pending-update] A dependency update was scheduled by "Update OTForge".')
console.log('[apply-pending-update] Applying it now (npm update)...')

// `npm update`, not `npm install`. A plain install treats an already-installed
// version that still satisfies its declared range as good enough and won't
// touch it, even when a newer non-breaking patch has been published upstream --
// confirmed live: a student hit a stale, vulnerable transitive brace-expansion
// left behind by repeated `npm install` runs. `npm update` re-resolves every
// dependency against its declared range and upgrades to the newest version
// that still satisfies it.
//
// Passed as ONE command string with `shell: true`, rather than a command plus
// an args array. Both halves of that are forced:
//
//   - `shell: true` is required at all, because on Windows `npm` is a .cmd
//     shim and Node has refused to spawn .cmd/.bat without a shell since the
//     CVE-2024-27980 mitigation. Spawning "npm.cmd" directly fails outright.
//   - Given a shell, the args must be inlined, because passing an args array
//     alongside `shell: true` trips Node's DEP0190 deprecation (the args get
//     concatenated rather than escaped) which is slated to become an error.
//
// Safe here because every token is a hardcoded literal -- no user, scenario,
// or filesystem input reaches this string. Mirrors runStreamedCommand() in
// packages/app/src/main/index.ts, which joins for the same reason.
const result = spawnSync('npm update --legacy-peer-deps --no-package-lock', {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: true
})

if (result.status !== 0) {
  console.error(
    `\n[apply-pending-update] npm update failed (exit code ${result.status}).\n` +
      '[apply-pending-update] Keeping the request queued - it will be retried next launch.\n' +
      '[apply-pending-update] Continuing startup with the dependencies you already have.'
  )
  // Deliberately exit 0. A failed dependency refresh should not block the app
  // from starting with a perfectly usable existing node_modules -- students in
  // a lab with flaky wifi still need to run OTForge.
  process.exit(0)
}

unlinkSync(SENTINEL)
console.log('[apply-pending-update] Dependencies updated.')

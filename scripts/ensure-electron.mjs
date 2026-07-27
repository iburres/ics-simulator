/**
 * ensure-electron.mjs — guarantees the Electron *binary* is present before
 * `npm run dev` tries to launch it.
 *
 * WHY THIS EXISTS
 * ---------------
 * The `electron` npm package is only a thin shim. The real ~150 MB Electron
 * runtime (electron.exe / Electron.app / the `electron` ELF binary, plus
 * dist/resources/default_app.asar) is downloaded separately by the package's
 * own `install.js` postinstall script. If that download never runs, or if the
 * dist/ folder is removed afterwards, `npm run dev` fails at launch even
 * though `npm install` reported success and node_modules looks complete.
 *
 * Two real failures made this script necessary:
 *
 *   1. `predev` used to hardcode `node node_modules/electron/install.js`.
 *      This is an npm *workspaces* repo, so whether `electron` lands in the
 *      root node_modules (hoisted) or in packages/app/node_modules (nested)
 *      is an npm implementation detail that changes with peer-dependency
 *      resolution, `legacy-peer-deps`, and any `overrides` block. When npm
 *      nested it, the hardcoded root path threw MODULE_NOT_FOUND and every
 *      `npm run dev` aborted. Never assume hoisting -- always resolve.
 *
 *   2. The in-app "Update OTForge" button ran `npm update` from inside the
 *      *running* Electron process. On Windows the running process holds open
 *      handles on electron.exe and default_app.asar, so npm's rename failed
 *      with EBUSY (errno -4082) partway through replacing the package. That
 *      left the shim installed but dist/ gone -- an install that looks valid
 *      to npm but cannot start.
 *
 * Because this script re-downloads whatever is missing, a plain `npm run dev`
 * now self-heals both states instead of requiring manual intervention.
 *
 * It is deliberately idempotent and cheap: when the binary is already present
 * it exits immediately without touching the network, so it adds no measurable
 * cost to normal startup.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every location npm might legitimately place `electron` in this workspace,
 * in the order we should prefer them. Root first (the hoisted case, which is
 * what npm does most of the time), then the workspace package that actually
 * declares electron as a devDependency (the nested case).
 *
 * Resolving by probing real paths rather than using require.resolve() avoids
 * a subtle trap: electron's package.json may expose an "exports" map that
 * blocks require.resolve('electron/package.json'), and require.resolve('electron')
 * returns the JS shim's entry point rather than the package directory.
 */
const CANDIDATE_DIRS = [
  join(projectRoot, 'node_modules', 'electron'),
  join(projectRoot, 'packages', 'app', 'node_modules', 'electron')
]

/** Finds the installed electron package directory, or null if npm never installed it. */
function findElectronDir() {
  return CANDIDATE_DIRS.find((dir) => existsSync(join(dir, 'install.js'))) ?? null
}

/**
 * Reports whether the actual runtime binary is present.
 *
 * install.js writes `path.txt` containing the platform-specific executable
 * path *relative to dist/* (e.g. "electron.exe" on Windows, "Electron.app/
 * Contents/MacOS/Electron" on macOS). Checking path.txt AND the file it names
 * is the only cross-platform-correct test -- hardcoding "electron.exe" would
 * silently pass on macOS and Linux where that file never exists.
 *
 * Both checks matter: a failed npm rename can leave path.txt behind after
 * dist/ is gone, so the presence of path.txt alone proves nothing.
 */
function binaryPresent(electronDir) {
  const pathTxt = join(electronDir, 'path.txt')
  if (!existsSync(pathTxt)) return false

  const relativeExe = readFileSync(pathTxt, 'utf8').trim()
  if (!relativeExe) return false

  return existsSync(join(electronDir, 'dist', relativeExe))
}

const electronDir = findElectronDir()

if (!electronDir) {
  console.error(
    '[ensure-electron] Could not find the electron package in node_modules.\n' +
      '[ensure-electron] Run `npm install --legacy-peer-deps --no-package-lock` first, then try again.'
  )
  process.exit(1)
}

if (binaryPresent(electronDir)) {
  console.log('[ensure-electron] Electron binary already present - skipping download.')
  process.exit(0)
}

console.log(`[ensure-electron] Electron binary missing in ${electronDir}`)
console.log('[ensure-electron] Downloading it now (this can take a minute on first run)...')

// Run install.js as its own process rather than importing it. It is written as
// a side-effecting CommonJS script, and spawning keeps its stdout/stderr (the
// download progress and any proxy/network errors) visible to the user, which
// matters because this is the step most likely to fail on a locked-down campus
// network.
const result = spawnSync(process.execPath, [join(electronDir, 'install.js')], {
  cwd: electronDir,
  stdio: 'inherit'
})

if (result.status !== 0) {
  console.error(
    `\n[ensure-electron] Electron download failed (exit code ${result.status}).\n` +
      '[ensure-electron] If you are behind a proxy or firewall, set ELECTRON_MIRROR or\n' +
      '[ensure-electron] ELECTRON_GET_USE_PROXY, then run `npm run dev` again.'
  )
  process.exit(result.status ?? 1)
}

console.log('[ensure-electron] Electron binary installed.')

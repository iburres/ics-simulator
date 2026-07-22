/**
 * resource-estimator.ts — RAM and CPU estimation for a simulation scenario.
 *
 * Before launching a simulation the app checks whether the host machine has
 * sufficient free memory to run all the containers the scenario will create.
 * This module provides the estimation logic and the system-memory comparison.
 *
 * Estimation model:
 *   - Each device gets a flat RAM budget based on its category (e.g., PLC uses
 *     more RAM than a simple sensor because it runs OpenPLC Runtime).
 *   - Fixed infrastructure containers (Suricata, Zeek, InfluxDB, Grafana, Loki,
 *     FUXA, Firewall) are always included regardless of scenario contents.
 *   - The attack machine (Kali) adds a larger budget due to the pre-installed tooling.
 *   - CPU estimation is coarse: 1 core per 5 containers, minimum 1.
 *
 * These numbers are deliberate overestimates — containers rarely consume their
 * full budget, but we want to warn users before their system becomes unresponsive.
 *
 * Warning thresholds:
 *   60% of free RAM → info-level warning, user can proceed
 *   85% of free RAM → warning-level warning, default button is Cancel
 */

import os from 'os'
import { execSync } from 'child_process'
import type { OTForgeScenario, ResourceEstimate } from '@otforge/schema'

/**
 * Returns truly available memory in bytes.
 *
 * macOS `os.freemem()` only counts pages with no content at all — it ignores
 * inactive and speculative pages that the kernel will reclaim instantly under
 * pressure. On a healthy Mac this makes freemem look critically low even when
 * gigabytes are available.  We parse `vm_stat` to get the real picture.
 *
 * Linux exposes `MemAvailable` in /proc/meminfo (kernel 3.14+), which already
 * accounts for reclaimable caches.
 *
 * Windows: `os.freemem()` calls GlobalMemoryStatusEx, which returns available
 * physical memory — already the right metric.
 */
function availableMemBytes(): number {
  try {
    if (process.platform === 'darwin') {
      // vm_stat output (excerpt):
      //   Mach Virtual Memory Statistics: (page size of 16384 bytes)
      //   Pages free:                           1234.
      //   Pages inactive:                       5678.
      //   Pages speculative:                     900.
      //   Pages purgeable:                       200.
      const raw = execSync('vm_stat', { encoding: 'utf8', timeout: 2000 })
      const pageMatch = raw.match(/page size of (\d+) bytes/)
      const pageBytes = pageMatch ? parseInt(pageMatch[1], 10) : 4096
      const pages = (label: string): number => {
        const m = raw.match(new RegExp(`${label}:\\s+([\\d]+)\\.`))
        return m ? parseInt(m[1], 10) : 0
      }
      const available =
        (pages('Pages free') +
          pages('Pages inactive') +
          pages('Pages speculative') +
          pages('Pages purgeable')) *
        pageBytes
      return available > 0 ? available : os.freemem()
    }

    if (process.platform === 'linux') {
      const meminfo = execSync('grep MemAvailable /proc/meminfo', {
        encoding: 'utf8',
        timeout: 2000
      })
      const m = meminfo.match(/MemAvailable:\s+(\d+)\s+kB/)
      if (m) return parseInt(m[1], 10) * 1024
    }
  } catch {
    // Fall through to os.freemem() if the platform command fails
  }
  return os.freemem()
}

// ── Per-container RAM budgets (MB) ────────────────────────────────────────────
// These match the `deploy.resources.limits.memory` values in the compose generator.

/** Standard device budget — Modbus/DNP3 Python servers on Alpine. */
const RAM_DEVICE = 80

/** PLC devices run OpenPLC Runtime (Ubuntu 22.04 + build toolchain). */
const RAM_OPENPLC = 128

/** OPC UA server (asyncua Python) — larger footprint than simple Modbus devices. */
const RAM_OPCUA = 256

const RAM_SURICATA = 150
const RAM_ZEEK = 150
const RAM_INFLUXDB = 200
const RAM_GRAFANA = 150
const RAM_LOKI = 80
const RAM_FUXA = 100
const RAM_FIREWALL = 20

/** Engineering workstation: Ubuntu 22.04 Xfce4 + TigerVNC + Wireshark + Python ICS libs. */
const RAM_WORKSTATION = 512

/** Kali Linux image with nmap, Metasploit, pymodbus, tshark pre-installed. */
const RAM_ATTACK = 512

/**
 * Sum of all fixed infrastructure containers that are always included.
 * These run in every simulation regardless of the device graph contents.
 */
const FIXED_INFRA_RAM =
  RAM_SURICATA + RAM_ZEEK + RAM_INFLUXDB + RAM_GRAFANA + RAM_LOKI + RAM_FUXA + RAM_FIREWALL

/**
 * Estimates the RAM and CPU requirements for a given scenario.
 *
 * The estimate is used to:
 *   1. Display a "This scenario requires ~X MB" summary after import.
 *   2. Compare against available system memory to decide whether to warn the user.
 *
 * @param scenario - The scenario whose device graph to evaluate.
 * @returns ResourceEstimate with estimatedRamMb, estimatedCpuCores, containerCount.
 */
export function estimateResources(scenario: OTForgeScenario): ResourceEstimate {
  const devices = Object.values(scenario.devices.devices)
  const containerCount = devices.length

  // Sum per-device RAM, giving PLCs, OPC UA servers, and workstations their larger budgets
  const deviceRam = devices.reduce((total, device) => {
    if (
      device.category === 'plc' ||
      device.category === 'safety-plc' ||
      device.category === 'batch-controller'
    )
      return total + RAM_OPENPLC
    if (device.category === 'scada-server') return total + RAM_OPCUA
    if (device.category === 'engineering-workstation') return total + RAM_WORKSTATION
    return total + RAM_DEVICE
  }, 0)

  const hasAttackMachine = devices.some(d => d.category === 'attack-machine')
  const attackRam = hasAttackMachine ? RAM_ATTACK : 0

  const estimatedRamMb = deviceRam + FIXED_INFRA_RAM + attackRam

  // CPU estimate: 1 core per 5 containers, minimum 1 (very coarse, shown as advisory only)
  const estimatedCpuCores = Math.max(1, Math.ceil(containerCount / 5))

  // Total containers = user devices + 7 fixed infra (Suricata, Zeek, InfluxDB, Grafana, Loki, FUXA, firewall)
  const totalContainers = containerCount + 7 + (hasAttackMachine ? 0 : 0)

  return { estimatedRamMb, estimatedCpuCores, containerCount: totalContainers }
}

/**
 * Describes the host machine's available memory relative to a resource estimate.
 */
export interface SystemMemory {
  /** Total installed RAM in MB. */
  totalMb: number
  /** Currently free (unallocated) RAM in MB. */
  freeMb: number
  /** True when the estimate is below 85% of free RAM (scenario should run comfortably). */
  sufficientForScenario: boolean
  /** True when estimate exceeds 60% of free RAM — show an info warning. */
  warningThreshold: boolean
  /** True when estimate exceeds 85% of free RAM — show a danger warning. */
  criticalThreshold: boolean
}

/**
 * Compares a resource estimate against the current system's available memory.
 *
 * Uses `os.freemem()` which returns the amount of memory not currently in use by
 * processes. This is more relevant than total RAM for a running system, but it can
 * fluctuate. The estimate is intentionally conservative to account for overhead.
 *
 * @param estimate - ResourceEstimate returned by estimateResources().
 * @returns SystemMemory object with threshold flags for the UI warning logic.
 */
export function checkSystemMemory(estimate: ResourceEstimate): SystemMemory {
  const totalMb = Math.round(os.totalmem() / 1024 / 1024)
  const freeMb = Math.round(availableMemBytes() / 1024 / 1024)
  const ratio = estimate.estimatedRamMb / freeMb

  return {
    totalMb,
    freeMb,
    sufficientForScenario: ratio < 0.85,
    warningThreshold: ratio >= 0.6, // ≥60% of free RAM: show advisory notice
    criticalThreshold: ratio >= 0.85 // ≥85% of free RAM: show danger warning, default to Cancel
  }
}

/** Returns available system memory in MB using the platform-aware availableMemBytes(). */
export function getAvailableMemMb(): number {
  return Math.round(availableMemBytes() / 1024 / 1024)
}

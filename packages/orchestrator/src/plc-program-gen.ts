/**
 * Edge-aware OpenPLC ST for PLCs with no authored plcProgram.
 * Coils from coilSource edges + PLC↔pump/valve links; spare coil if none (502 binds).
 * Also: M-out-of-N safety voting ST for safety-plc devices wired directly to
 * redundant smart-sensor inputs (see buildSafetyVotingProgram below).
 */

import type {
  CanvasEdge,
  OTForgeScenario,
  PLCProgramConfig,
  SafetyPlcConfig
} from '@otforge/schema'

const ACTUATOR = new Set(['pump', 'valve', 'vfd', 'actuator'])

/** UTF-8 base64 — plain btoa throws on non-Latin1 (crashed Save Program on old template). */
export function toB64(text: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(text, 'utf8').toString('base64')
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

export function fromB64(b64: string): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').toString('utf8')
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

function peerKind(scenario: OTForgeScenario, id: string): string | null {
  const k = scenario.devices.devices[id]?.controller?.kind
  if (k && ACTUATOR.has(k)) return k
  const t = scenario.visual.nodes.find(n => n.id === id)?.type
  return t && ACTUATOR.has(t) ? t : null
}

function otherEnd(edge: CanvasEdge, id: string): string | null {
  if (edge.source === id) return edge.target
  if (edge.target === id) return edge.source
  return null
}

function iecAddr(i: number): string {
  return `%QX${Math.floor(i / 8)}.${i % 8}`
}

function ident(id: string, kind: string | null): string {
  const base =
    id
      .replace(/[^a-zA-Z0-9_]/g, '_')
      .replace(/^(\d)/, '_$1')
      .toLowerCase() || 'coil'
  return `${base}_${kind === 'valve' ? 'open' : 'run'}`
}

/** Coil map for a PLC — explicit coilSource first, then direct actuator edges. */
function inferPlcCoilBindings(
  scenario: OTForgeScenario,
  plcId: string
): Array<{ coilIndex: number; peerId: string; varName: string }> {
  const byCoil = new Map<number, { coilIndex: number; peerId: string; varName: string }>()
  const used = new Set<string>()

  const put = (coilIndex: number, peerId: string): void => {
    const kind = peerKind(scenario, peerId)
    const cur = byCoil.get(coilIndex)
    if (cur && peerKind(scenario, cur.peerId) && !kind) return
    byCoil.set(coilIndex, { coilIndex, peerId, varName: ident(peerId, kind) })
    used.add(peerId)
  }

  for (const edge of scenario.visual.edges) {
    const cs = edge.data.coilSource
    if (!cs || cs.nodeId !== plcId) continue
    const a = otherEnd(edge, plcId)
    const peer =
      (a && peerKind(scenario, a) ? a : null) ??
      (peerKind(scenario, edge.source) ? edge.source : null) ??
      (peerKind(scenario, edge.target) ? edge.target : null) ??
      a ??
      edge.target
    put(cs.coilIndex, peer)
  }

  let next = 0
  for (const edge of scenario.visual.edges) {
    const peer = otherEnd(edge, plcId)
    if (!peer || !peerKind(scenario, peer) || used.has(peer)) continue
    if (edge.data.coilSource?.nodeId === plcId) continue
    while (byCoil.has(next)) next++
    put(next++, peer)
  }

  return [...byCoil.values()].sort((a, b) => a.coilIndex - b.coilIndex)
}

function linkedToProcessUnit(scenario: OTForgeScenario, plcId: string): boolean {
  for (const e of scenario.visual.edges) {
    const cats = [e.source, e.target].map(id => scenario.devices.devices[id]?.category)
    const touchesPu = cats.includes('process-unit')
    if (!touchesPu) continue
    if (e.data.coilSource?.nodeId === plcId || e.source === plcId || e.target === plcId) return true
  }
  return false
}

// ── Safety/SIS M-out-of-N voting ─────────────────────────────────────────────

/**
 * Direct safety-plc↔smart-sensor edges, in edge-iteration order. Unlike
 * inferPlcCoilBindings' actuator side, there's no coilSource-equivalent to
 * resolve here — a safety-plc directly wired to a smart-sensor unambiguously
 * means that sensor feeds the safety vote, so a plain edge scan is enough.
 */
export function inferSisSensorNodeIds(scenario: OTForgeScenario, plcId: string): string[] {
  const ids: string[] = []
  for (const edge of scenario.visual.edges) {
    const peer = otherEnd(edge, plcId)
    if (peer && scenario.devices.devices[peer]?.category === 'smart-sensor') ids.push(peer)
  }
  return ids
}

/**
 * Parses "MooN" voting config (e.g. "2oo3") into { m, n }, clamping m to the
 * number of sensors actually wired if fewer are connected than the config
 * declares. This is also the physically-correct real-world behavior for a
 * partially-installed SIS — a vote can never require more inputs than exist.
 * Falls back to requiring all wired sensors to agree (effectively 1oo1 for a
 * single sensor) when votingConfig is unset or doesn't parse.
 */
function parseVotingThreshold(
  votingConfig: SafetyPlcConfig['votingConfig'] | undefined,
  wiredCount: number
): number {
  const match = votingConfig?.match(/^(\d)oo(\d)$/)
  const declaredM = match ? parseInt(match[1], 10) : wiredCount
  return Math.max(1, Math.min(declaredM, wiredCount))
}

/**
 * Real M-out-of-N safety voting ST — not a scaffold, actual comparator logic.
 * Reads each wired sensor's polled Modbus value (populated at %IW100+i by
 * OpenPLC's Modbus-master engine polling the devices listed in the
 * SIS_MBCONFIG_B64-generated mbconfig.cfg — see compose-generator.ts), counts
 * how many exceed the trip threshold, and only de-energizes trip_relay
 * (Lab04 convention: TRUE=safe/armed, FALSE=tripped) when the vote count
 * reaches the configured M.
 *
 * Threshold defaults to 80% of the wired sensors' own maxValue (they should
 * share a range, being redundant copies of the same measurement) — a simple,
 * adjustable convention, not a claimed-precise SIL calculation. An
 * author-configurable explicit setpoint is a natural follow-up, intentionally
 * out of scope here.
 *
 * Sensor values are x10 fixed-point on the wire (containers/modbus/server.py's
 * SENSOR_MODBUS_REGISTER convention), so the threshold is scaled by 10 to
 * compare directly against the raw register value.
 */
export function buildSafetyVotingProgram(
  scenario: OTForgeScenario,
  sensorNodeIds: string[],
  votingConfig: SafetyPlcConfig['votingConfig'] | undefined
): PLCProgramConfig {
  const m = parseVotingThreshold(votingConfig, sensorNodeIds.length)

  const maxValues = sensorNodeIds
    .map(id => scenario.devices.devices[id]?.sensor?.maxValue)
    .filter((v): v is number => typeof v === 'number')
  const maxValue = maxValues.length > 0 ? Math.max(...maxValues) : 100
  const thresholdRaw = Math.round(maxValue * 0.8 * 10)

  const vars: string[] = []
  const logic: string[] = ['  vote_count := 0;']
  const variables: PLCProgramConfig['variables'] = []

  sensorNodeIds.forEach((nodeId, i) => {
    const varName = `sensor_${i}`
    vars.push(`    ${varName} AT %IW${100 + i} : INT;`)
    variables.push({
      name: varName,
      type: 'INT',
      address: `%IW${100 + i}`,
      protocol: 'modbus-tcp',
      protocolAddress: String(scenario.devices.devices[nodeId]?.sensor?.modbusRegister ?? 0)
    })
    logic.push(`  IF ${varName} > ${thresholdRaw} THEN vote_count := vote_count + 1; END_IF;`)
  })

  vars.push('    trip_relay AT %QX0.0 : BOOL;')
  logic.push(
    '',
    `  IF vote_count >= ${m} THEN`,
    '    trip_relay := FALSE; (* tripped — vote threshold reached *)',
    '  ELSE',
    '    trip_relay := TRUE; (* safe/armed *)',
    '  END_IF;'
  )

  const st = `(* auto-generated ${m}-out-of-${sensorNodeIds.length} safety voting — override via Save Program *)
PROGRAM main
  VAR
${vars.join('\n')}
  END_VAR
  VAR
    vote_count : INT;
  END_VAR

${logic.join('\n')}

END_PROGRAM

CONFIGURATION config0
  TASK task0(INTERVAL := T#100ms, PRIORITY := 0);
  PROGRAM inst0 WITH task0 : main;
END_CONFIGURATION
`

  return {
    language: 'st',
    source: toB64(st),
    variables
  }
}

/** Minimal ST + variable map. Author plcProgram.source must win at the call site. */
export function buildAutoPlcProgram(scenario: OTForgeScenario, plcId: string): PLCProgramConfig {
  let bindings = inferPlcCoilBindings(scenario, plcId)
  if (bindings.length === 0) {
    bindings = [{ coilIndex: 0, peerId: plcId, varName: 'spare_0' }]
  }

  const vars: string[] = []
  const logic: string[] = []
  const variables: PLCProgramConfig['variables'] = []

  for (const b of bindings) {
    vars.push(`    ${b.varName} AT ${iecAddr(b.coilIndex)} : BOOL;`)
    variables.push({
      name: b.varName,
      type: 'BOOL',
      address: iecAddr(b.coilIndex),
      protocol: 'modbus-tcp',
      protocolAddress: String(b.coilIndex)
    })
  }

  // ponytail: first 4 coils → process-sim master outs; expand if >4 actuators matter
  if (linkedToProcessUnit(scenario, plcId)) {
    for (let i = 0; i < Math.min(4, bindings.length); i++) {
      const out = `${bindings[i].varName}_out`
      vars.push(`    ${out} AT %QX100.${i} : BOOL;`)
      logic.push(`  ${out} := ${bindings[i].varName};`)
    }
    vars.push(`    level_raw AT %IW100 : INT;`, `    tank_level AT %QW0 : INT;`)
    logic.push(`  tank_level := level_raw;`)
  }

  const st = `(* auto-generated — override via Save Program *)
PROGRAM main
  VAR
${vars.join('\n')}
  END_VAR
${logic.length ? '\n' + logic.join('\n') + '\n' : ''}
END_PROGRAM

CONFIGURATION config0
  TASK task0(INTERVAL := T#100ms, PRIORITY := 0);
  PROGRAM inst0 WITH task0 : main;
END_CONFIGURATION
`

  return {
    language: 'st',
    source: toB64(st),
    variables
  }
}

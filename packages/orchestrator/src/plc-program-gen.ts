/**
 * Edge-aware OpenPLC ST for PLCs with no authored plcProgram.
 * Coils from coilSource edges + PLC↔pump/valve links; spare coil if none (502 binds).
 * Also: M-out-of-N safety voting ST for safety-plc devices wired directly to
 * redundant smart-sensor inputs (see buildSafetyVotingProgram below), and an
 * ISA-88 batch phase-sequencer for batch-controller devices wired to a
 * batch-reactor process-unit (see buildBatchProgram below).
 */

import type {
  BatchConfig,
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

// ── ISA-88 batch control ──────────────────────────────────────────────────────

/**
 * Direct batch-controller↔process-unit edge scan, returning the wired
 * process-unit's nodeId only when its processType is 'batch-reactor' —
 * mirrors inferSisSensorNodeIds' plain edge-scan style above. A
 * batch-controller wired to any OTHER process-unit type (or to none) gets no
 * batch program; compose-generator.ts falls back to buildAutoPlcProgram.
 */
export function inferBatchReactorNodeId(
  scenario: OTForgeScenario,
  plcId: string
): string | undefined {
  for (const edge of scenario.visual.edges) {
    const peer = otherEnd(edge, plcId)
    const peerDevice = peer ? scenario.devices.devices[peer] : undefined
    if (
      peer &&
      peerDevice?.category === 'process-unit' &&
      peerDevice.processUnit?.processType === 'batch-reactor'
    ) {
      return peer
    }
  }
  return undefined
}

/**
 * Real ISA-88 batch phase-sequencer ST — not a scaffold. Implements the
 * actual S88 state model (IDLE/RUNNING/HELD/ABORTED/COMPLETE) driving a
 * fixed 5-phase unit procedure (CHARGE/HEAT/REACT/COOL/DISCHARGE) against
 * the wired batch-reactor process-unit, over the SAME PROCESS_SIM_IP +
 * mbconfig.cfg Modbus-master wiring a plain PLC already uses for a single
 * process-unit (see compose-generator.ts) — just with Coils_Size=6 and
 * Holding_Registers_Read_Size=5 instead of the plain-PLC path's 4/1, so all
 * six reactor coils and five PVs are reachable at %QX100.0-.5/%IW100-104.
 *
 * Deliberately uses only IF/ELSIF chains and plain arithmetic (no CASE, no
 * TON timer function blocks) — matiec support for those is unproven in this
 * codebase, and buildSafetyVotingProgram's IF/ELSE-only style already has a
 * confirmed-working precedent, so REACT's hold duration is tracked as a
 * manual tick counter against the CONFIGURATION's fixed T#100ms scan
 * interval rather than a TON block.
 *
 * current_phase/batch_state are located %QW outputs — readable AND writable
 * over Modbus on the batch-controller's OWN port 502 with no authentication,
 * same as trip_relay AT %QX0.0 in buildSafetyVotingProgram: an external
 * FC06/FC16 write can force-skip a phase or fake COMPLETE, since nothing in
 * the ST "self-overrides" an unexpected value. Deliberate — this is what
 * makes a future attack tutorial possible without a new vulnerability class.
 */
export function buildBatchProgram(
  scenario: OTForgeScenario,
  reactorNodeId: string,
  batchConfig: BatchConfig | undefined
): PLCProgramConfig {
  const reactor = scenario.devices.devices[reactorNodeId]?.processUnit
  const tankVolumeL = reactor?.tankVolumeL ?? 1000
  const tankAreaM2 = reactor?.tankAreaM2 ?? 1.0
  const levelM = (pct: number) => (pct / 100) * (tankVolumeL / (tankAreaM2 * 1000))

  // Raw register scaling matches containers/process-sim/sim.py's write_pvs():
  // LEVEL_PV ×100 (0.01 m resolution), TEMPERATURE_PV ×10 (0.1 °C resolution).
  const chargeTargetRaw = Math.round(levelM(batchConfig?.chargeTargetPct ?? 80) * 100)
  const dischargeTargetRaw = Math.round(levelM(batchConfig?.dischargeTargetPct ?? 5) * 100)
  const heatSetpointRaw = Math.round((batchConfig?.heatSetpointC ?? 70) * 10)
  const coolSetpointRaw = Math.round((batchConfig?.coolSetpointC ?? 30) * 10)
  // CONFIGURATION's TASK interval is a fixed T#100ms scan — 10 ticks/second.
  const reactHoldTicks = Math.round((batchConfig?.reactHoldSec ?? 60) * 10)

  const st = `(* auto-generated ISA-88 batch sequencer — override via Save Program *)
PROGRAM main
  VAR
    level_pv AT %IW100 : INT;
    flow_in_pv AT %IW101 : INT;
    flow_out_pv AT %IW102 : INT;
    pressure_pv AT %IW103 : INT;
    temp_pv AT %IW104 : INT;
    agitator_out AT %QX100.0 : BOOL;
    charge_valve_out AT %QX100.1 : BOOL;
    discharge_valve_out AT %QX100.2 : BOOL;
    esd_out AT %QX100.3 : BOOL;
    heater_out AT %QX100.4 : BOOL;
    cooling_out AT %QX100.5 : BOOL;
    batch_state AT %QW0 : INT;
    current_phase AT %QW1 : INT;
    start_cmd AT %QX0.0 : BOOL;
    hold_cmd AT %QX0.1 : BOOL;
    resume_cmd AT %QX0.2 : BOOL;
    abort_cmd AT %QX0.3 : BOOL;
    reset_cmd AT %QX0.4 : BOOL;
  END_VAR
  VAR
    react_ticks : INT;
  END_VAR

  (* batch_state: 0=IDLE 1=RUNNING 2=HELD 3=ABORTED 4=COMPLETE *)
  (* current_phase (meaningful only while RUNNING): 0=NONE 1=CHARGE 2=HEAT 3=REACT 4=COOL 5=DISCHARGE *)

  IF abort_cmd THEN
    batch_state := 3;
    current_phase := 0;
  ELSIF batch_state = 3 THEN
    IF reset_cmd THEN
      batch_state := 0;
      current_phase := 0;
      react_ticks := 0;
    END_IF;
  ELSIF batch_state = 0 THEN
    IF start_cmd THEN
      batch_state := 1;
      current_phase := 1;
      react_ticks := 0;
    END_IF;
  ELSIF batch_state = 4 THEN
    IF reset_cmd THEN
      batch_state := 0;
      current_phase := 0;
    END_IF;
  ELSIF hold_cmd AND batch_state = 1 THEN
    batch_state := 2;
  ELSIF batch_state = 2 THEN
    IF resume_cmd THEN
      batch_state := 1;
    END_IF;
  ELSIF batch_state = 1 THEN
    IF current_phase = 1 THEN
      IF level_pv >= ${chargeTargetRaw} THEN current_phase := 2; END_IF;
    ELSIF current_phase = 2 THEN
      IF temp_pv >= ${heatSetpointRaw} THEN current_phase := 3; react_ticks := 0; END_IF;
    ELSIF current_phase = 3 THEN
      react_ticks := react_ticks + 1;
      IF react_ticks >= ${reactHoldTicks} THEN current_phase := 4; END_IF;
    ELSIF current_phase = 4 THEN
      IF temp_pv <= ${coolSetpointRaw} THEN current_phase := 5; END_IF;
    ELSIF current_phase = 5 THEN
      IF level_pv <= ${dischargeTargetRaw} THEN
        batch_state := 4;
        current_phase := 0;
      END_IF;
    END_IF;
  END_IF;

  IF batch_state = 1 THEN
    charge_valve_out := (current_phase = 1);
    heater_out := (current_phase = 2);
    agitator_out := (current_phase = 2) OR (current_phase = 3);
    cooling_out := (current_phase = 4);
    discharge_valve_out := (current_phase = 5);
  ELSE
    charge_valve_out := FALSE;
    heater_out := FALSE;
    agitator_out := FALSE;
    cooling_out := (batch_state = 3);
    discharge_valve_out := FALSE;
  END_IF;
  esd_out := (batch_state = 3);

END_PROGRAM

CONFIGURATION config0
  TASK task0(INTERVAL := T#100ms, PRIORITY := 0);
  PROGRAM inst0 WITH task0 : main;
END_CONFIGURATION
`

  return {
    language: 'st',
    source: toB64(st),
    variables: [
      {
        name: 'level_pv',
        type: 'INT',
        address: '%IW100',
        protocol: 'modbus-tcp',
        protocolAddress: '0'
      },
      {
        name: 'flow_in_pv',
        type: 'INT',
        address: '%IW101',
        protocol: 'modbus-tcp',
        protocolAddress: '1'
      },
      {
        name: 'flow_out_pv',
        type: 'INT',
        address: '%IW102',
        protocol: 'modbus-tcp',
        protocolAddress: '2'
      },
      {
        name: 'pressure_pv',
        type: 'INT',
        address: '%IW103',
        protocol: 'modbus-tcp',
        protocolAddress: '3'
      },
      {
        name: 'temp_pv',
        type: 'INT',
        address: '%IW104',
        protocol: 'modbus-tcp',
        protocolAddress: '4'
      },
      {
        name: 'agitator_out',
        type: 'BOOL',
        address: '%QX100.0',
        protocol: 'modbus-tcp',
        protocolAddress: '0'
      },
      {
        name: 'charge_valve_out',
        type: 'BOOL',
        address: '%QX100.1',
        protocol: 'modbus-tcp',
        protocolAddress: '1'
      },
      {
        name: 'discharge_valve_out',
        type: 'BOOL',
        address: '%QX100.2',
        protocol: 'modbus-tcp',
        protocolAddress: '2'
      },
      {
        name: 'esd_out',
        type: 'BOOL',
        address: '%QX100.3',
        protocol: 'modbus-tcp',
        protocolAddress: '3'
      },
      {
        name: 'heater_out',
        type: 'BOOL',
        address: '%QX100.4',
        protocol: 'modbus-tcp',
        protocolAddress: '4'
      },
      {
        name: 'cooling_out',
        type: 'BOOL',
        address: '%QX100.5',
        protocol: 'modbus-tcp',
        protocolAddress: '5'
      }
    ]
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

/**
 * compose-generator.test.ts — Unit tests for Docker Compose file generation.
 *
 * generateCompose() is the core of the simulation engine. A bug here means
 * containers get wrong IPs, wrong images, wrong capabilities, or wrong port
 * mappings — all silent until someone tries to run the scenario. These tests
 * catch regressions before they reach a user's machine.
 *
 * Testing approach:
 *   - Call generateCompose() with controlled scenario fixtures.
 *   - Parse the resulting YAML string with js-yaml.
 *   - Assert on the parsed object structure rather than on raw YAML text, so
 *     tests do not break when formatting or key ordering changes.
 *
 * Coverage target — each special-case branch in generateCompose():
 *   - All six Purdue Model zone networks emitted (ot, control, plant-dmz, enterprise,
 *     internet-dmz, attacker) even when the scenario only defines a subset
 *   - Firewall multi-zone attachment to ot-net + control-net + plant-dmz-net
 *   - Attack machine attacker-net isolation + capability grants + noVNC port
 *   - PLC web UI port publishing (deterministic sequential assignment)
 *   - Protocol environment variable injection (Modbus, DNP3, OPC-UA)
 *   - PLC program pre-load via INITIAL_PROGRAM_B64
 *   - Infrastructure services always present (Suricata, Zeek, InfluxDB, etc.)
 *   - Default zone subnet backfill for zones not defined in the scenario
 */

import { describe, it, expect } from 'vitest'
import yaml from 'js-yaml'
import { generateCompose } from '../compose-generator'
import type { OTForgeScenario, DeviceConfig, NetworkZone } from '@otforge/schema'

// ── Parsed compose types ──────────────────────────────────────────────────────

interface ParsedService {
  image: string
  container_name: string
  restart: string
  networks: Record<string, { ipv4_address: string }>
  /** Host/bridge/none network mode. Set instead of networks for Suricata (AF_PACKET). */
  network_mode?: string
  environment?: string[]
  cap_add?: string[]
  ports?: string[]
  volumes?: string[]
  deploy: { resources: { limits: { memory: string; cpus: string } } }
}

interface ParsedCompose {
  name: string
  services: Record<string, ParsedService>
  networks: Record<
    string,
    {
      driver: string
      ipam: { config: Array<{ subnet: string; gateway: string }> }
    }
  >
  volumes?: Record<string, unknown>
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Generates compose YAML and returns the parsed object. */
function gen(scenario: OTForgeScenario, projectName = 'test-proj'): ParsedCompose {
  return yaml.load(generateCompose(scenario, projectName)) as ParsedCompose
}

type DeviceOverrides = Partial<DeviceConfig> & Pick<DeviceConfig, 'category' | 'ipAddress'>

/**
 * Builds a minimal type-correct OTForgeScenario for testing.
 * Only fields that generateCompose() reads are populated.
 */
function makeScenario(
  deviceEntries: Array<[string, DeviceOverrides]>,
  segmentZones: Array<{ zone: NetworkZone; subnet: string; gateway: string }> = []
): OTForgeScenario {
  const devices: OTForgeScenario['devices']['devices'] = {}
  for (const [id, d] of deviceEntries) {
    devices[id] = { nodeId: id, protocols: [], ...d }
  }
  return {
    meta: {
      formatVersion: '1.0',
      name: 'Test',
      description: '',
      sector: 'water-treatment',
      author: 'test',
      createdAt: '',
      updatedAt: '',
      appVersion: '0.1.0',
      locked: false,
      brief: '',
      requirements: { estimatedRamMb: 0, estimatedCpuCores: 0, containerCount: 0 }
    },
    visual: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    network: {
      segments: segmentZones.map(s => ({ ...s, dockerNetwork: `${s.zone}-net` })),
      routes: []
    },
    devices: { devices },
    security: {
      defaultFirewallPolicy: 'deny',
      firewallRules: [],
      ids: { enabledRulesets: [], disabledRuleIds: [], zeekScripts: [] },
      logging: { retentionDays: 30, influxdbEnabled: true, lokiEnabled: true }
    },
    registry: [],
    packLayers: []
  }
}

// ── Docker networks ───────────────────────────────────────────────────────────

describe('Docker networks', () => {
  it('always emits all six Purdue zone networks even when the scenario only defines one segment', () => {
    const scenario = makeScenario(
      [['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]],
      [{ zone: 'ot', subnet: '10.200.10.0/24', gateway: '10.200.10.1' }]
    )
    const compose = gen(scenario)
    expect(compose.networks).toHaveProperty('ot-net')
    expect(compose.networks).toHaveProperty('control-net')
    expect(compose.networks).toHaveProperty('plant-dmz-net')
    expect(compose.networks).toHaveProperty('enterprise-net')
    expect(compose.networks).toHaveProperty('internet-dmz-net')
    expect(compose.networks).toHaveProperty('attacker-net')
  })

  it('uses an explicit scenario subnet when a zone segment is provided', () => {
    const scenario = makeScenario(
      [['plc-1', { category: 'plc', ipAddress: '10.0.1.10' }]],
      [{ zone: 'ot', subnet: '10.0.1.0/24', gateway: '10.0.1.1' }]
    )
    const compose = gen(scenario)
    expect(compose.networks['ot-net'].ipam.config[0].subnet).toBe('10.0.1.0/24')
    expect(compose.networks['ot-net'].ipam.config[0].gateway).toBe('10.0.1.1')
  })

  it('fills in ZONE_DEFAULT subnets (10.200.x.0/24) for all zones not present in the scenario', () => {
    // No segments defined — all six zones should come from ZONE_DEFAULTS
    const scenario = makeScenario([['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]])
    const compose = gen(scenario)
    expect(compose.networks['ot-net'].ipam.config[0].subnet).toBe('10.200.10.0/24')
    expect(compose.networks['control-net'].ipam.config[0].subnet).toBe('10.200.20.0/24')
    expect(compose.networks['plant-dmz-net'].ipam.config[0].subnet).toBe('10.200.30.0/24')
    expect(compose.networks['enterprise-net'].ipam.config[0].subnet).toBe('10.200.40.0/24')
    expect(compose.networks['internet-dmz-net'].ipam.config[0].subnet).toBe('10.200.50.0/24')
    expect(compose.networks['attacker-net'].ipam.config[0].subnet).toBe('10.200.60.0/24')
  })

  it('sets driver to "bridge" for all zone networks', () => {
    const compose = gen(makeScenario([['s1', { category: 'sensor', ipAddress: '10.200.10.10' }]]))
    for (const net of Object.values(compose.networks)) {
      expect(net.driver).toBe('bridge')
    }
  })

  it('marks all Purdue zone networks as internal: true to block outbound internet', () => {
    // internal: true tells Docker not to add an outbound NAT route.
    // All OT/IT/enterprise/DMZ zones must be isolated — only Kali (attacker-net) is exempt.
    const compose = gen(makeScenario([['s1', { category: 'sensor', ipAddress: '10.200.10.10' }]]))
    const internalNets = [
      'ot-net',
      'control-net',
      'plant-dmz-net',
      'enterprise-net',
      'internet-dmz-net'
    ]
    for (const name of internalNets) {
      expect((compose.networks[name] as { internal?: boolean }).internal).toBe(true)
    }
  })

  it('does NOT mark attacker-net as internal — Kali needs outbound internet access', () => {
    const compose = gen(makeScenario([['s1', { category: 'sensor', ipAddress: '10.200.10.10' }]]))
    expect((compose.networks['attacker-net'] as { internal?: boolean }).internal).toBeUndefined()
  })
})

// ── Device service generation ─────────────────────────────────────────────────

describe('image assignment', () => {
  it('uses the GHCR OpenPLC image for PLC devices', () => {
    const compose = gen(makeScenario([['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]]))
    expect(compose.services['plc-1'].image).toMatch(/otforge-openplc/)
  })

  it('uses the otforge-modbus image for RTU devices', () => {
    const compose = gen(makeScenario([['rtu-1', { category: 'rtu', ipAddress: '10.200.10.10' }]]))
    expect(compose.services['rtu-1'].image).toBe('ghcr.io/iburres/otforge-modbus:latest')
  })

  it('uses the otforge-dnp3 image for IED devices', () => {
    const compose = gen(makeScenario([['ied-1', { category: 'ied', ipAddress: '10.200.10.10' }]]))
    expect(compose.services['ied-1'].image).toBe('ghcr.io/iburres/otforge-dnp3:latest')
  })

  it('uses a custom dockerImage override when provided on the device', () => {
    const compose = gen(
      makeScenario([
        [
          'plc-custom',
          {
            category: 'plc',
            ipAddress: '10.200.10.10',
            dockerImage: 'my.registry.com/custom-plc:v2'
          }
        ]
      ])
    )
    expect(compose.services['plc-custom'].image).toBe('my.registry.com/custom-plc:v2')
  })

  it('gives smart-sensor the otforge-modbus image — a real container, not skipped', () => {
    const compose = gen(
      makeScenario([['sensor-1', { category: 'smart-sensor', ipAddress: '10.200.10.10' }]])
    )
    expect(compose.services['sensor-1']).toBeDefined()
    expect(compose.services['sensor-1'].image).toBe('ghcr.io/iburres/otforge-modbus:latest')
  })
})

describe('service name and container name', () => {
  it('lowercases node IDs and replaces underscores with hyphens', () => {
    const compose = gen(
      makeScenario([['PLC_Main_Unit', { category: 'plc', ipAddress: '10.200.10.10' }]])
    )
    expect(compose.services).toHaveProperty('plc-main-unit')
  })

  it('prefixes container_name with the project name', () => {
    const compose = gen(
      makeScenario([['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]]),
      'my-project'
    )
    expect(compose.services['plc-1'].container_name).toBe('my-project-plc-1')
  })

  it('sets project name from the projectName argument', () => {
    const compose = gen(
      makeScenario([['s1', { category: 'sensor', ipAddress: '10.200.10.10' }]]),
      'otforge-water-plant'
    )
    expect(compose.name).toBe('otforge-water-plant')
  })
})

describe('resource limits', () => {
  it('assigns 128m memory limit to PLC devices (OpenPLC needs Ubuntu + build tools)', () => {
    const compose = gen(makeScenario([['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]]))
    expect(compose.services['plc-1'].deploy.resources.limits.memory).toBe('128m')
  })

  it('assigns 80m memory limit to RTU devices (pymodbus on Alpine)', () => {
    const compose = gen(makeScenario([['rtu-1', { category: 'rtu', ipAddress: '10.200.10.10' }]]))
    expect(compose.services['rtu-1'].deploy.resources.limits.memory).toBe('80m')
  })

  it('assigns 2048m memory limit to attack machine (Kali + Xfce4 desktop + Metasploit)', () => {
    const compose = gen(
      makeScenario([['kali-1', { category: 'attack-machine', ipAddress: '10.200.60.10' }]])
    )
    expect(compose.services['kali-1'].deploy.resources.limits.memory).toBe('2048m')
  })
})

describe('network attachment', () => {
  it('attaches a device to the zone that contains its IP address', () => {
    const scenario = makeScenario(
      [['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]],
      [{ zone: 'ot', subnet: '10.200.10.0/24', gateway: '10.200.10.1' }]
    )
    const compose = gen(scenario)
    expect(compose.services['plc-1'].networks).toHaveProperty('ot-net')
    expect(compose.services['plc-1'].networks['ot-net'].ipv4_address).toBe('10.200.10.10')
  })

  it('attaches a control-zone device to control-net', () => {
    const scenario = makeScenario(
      [['hmi-1', { category: 'hmi', ipAddress: '10.200.20.10' }]],
      [{ zone: 'control', subnet: '10.200.20.0/24', gateway: '10.200.20.1' }]
    )
    const compose = gen(scenario)
    expect(compose.services['hmi-1'].networks).toHaveProperty('control-net')
    expect(compose.services['hmi-1'].networks['control-net'].ipv4_address).toBe('10.200.20.10')
  })

  it('falls back to ot-net when the device IP does not match any defined segment', () => {
    const scenario = makeScenario([['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]])
    const compose = gen(scenario)
    expect(compose.services['plc-1'].networks).toHaveProperty('ot-net')
  })

  it('sets restart to "unless-stopped" for all device services', () => {
    const compose = gen(makeScenario([['s1', { category: 'sensor', ipAddress: '10.200.10.10' }]]))
    expect(compose.services['s1'].restart).toBe('unless-stopped')
  })
})

// ── Special device categories ─────────────────────────────────────────────────

describe('firewall device', () => {
  /**
   * Firewall bridges OT (L0-L2), Control Center (L3), and Plant DMZ (L3.5)
   * simultaneously to enforce inter-zone ACLs via nftables rules.
   * It must NOT be on the attacker network — the Red Team zone is intentionally
   * separated from the Purdue zone stack.
   */
  const firewallCompose = () =>
    gen(makeScenario([['fw-1', { category: 'firewall', ipAddress: '10.200.10.254' }]]))

  it('attaches to ot-net, control-net, and plant-dmz-net simultaneously', () => {
    const nets = Object.keys(firewallCompose().services['fw-1'].networks)
    expect(nets).toContain('ot-net')
    expect(nets).toContain('control-net')
    expect(nets).toContain('plant-dmz-net')
  })

  it('attaches to attacker-net so Kali traffic is subject to nftables rules', () => {
    const nets = Object.keys(firewallCompose().services['fw-1'].networks)
    expect(nets).toContain('attacker-net')
  })

  it('does NOT attach to enterprise-net or internet-dmz-net', () => {
    const nets = Object.keys(firewallCompose().services['fw-1'].networks)
    expect(nets).not.toContain('enterprise-net')
    expect(nets).not.toContain('internet-dmz-net')
  })

  it('grants NET_ADMIN for nftables rule management', () => {
    expect(firewallCompose().services['fw-1'].cap_add).toContain('NET_ADMIN')
  })

  it('grants NET_RAW for ICMP and raw socket access', () => {
    expect(firewallCompose().services['fw-1'].cap_add).toContain('NET_RAW')
  })
})

describe('attack-machine device', () => {
  /**
   * Kali Linux is dual-homed: attacker-net (primary — has outbound internet access
   * because no internal: true) and internet-dmz-net (second leg — gives Kali direct
   * L2 adjacency to the web server and DNS server in the Internet DMZ zone).
   * This lets students run curl/nmap/exploits against scenario targets without
   * needing internet access on the target hosts, which are all on internal: true networks.
   */
  const attackCompose = () =>
    gen(makeScenario([['kali-1', { category: 'attack-machine', ipAddress: '10.200.60.10' }]]))

  it('attaches to attacker-net (primary) and internet-dmz-net (target reach)', () => {
    const nets = Object.keys(attackCompose().services['kali-1'].networks)
    expect(nets).toContain('attacker-net')
    expect(nets).toContain('internet-dmz-net')
  })

  it('does NOT attach to OT, Control, Plant-DMZ, or Enterprise networks', () => {
    const nets = Object.keys(attackCompose().services['kali-1'].networks)
    expect(nets).not.toContain('ot-net')
    expect(nets).not.toContain('control-net')
    expect(nets).not.toContain('plant-dmz-net')
    expect(nets).not.toContain('enterprise-net')
  })

  it('grants NET_ADMIN and NET_RAW for nmap raw scans and ARP operations', () => {
    expect(attackCompose().services['kali-1'].cap_add).toContain('NET_ADMIN')
    expect(attackCompose().services['kali-1'].cap_add).toContain('NET_RAW')
  })

  it('preserves the static IP on attacker-net', () => {
    expect(attackCompose().services['kali-1'].networks['attacker-net'].ipv4_address).toBe(
      '10.200.60.10'
    )
  })

  it('assigns .250 on internet-dmz-net (reserved system-service slot for Kali)', () => {
    const ip = attackCompose().services['kali-1'].networks['internet-dmz-net'].ipv4_address
    expect(ip).toBe('10.200.50.250')
  })

  it('publishes noVNC port 6080 on deterministic host port 6900 for the first attack machine', () => {
    // Phase 12: switched from linuxserver KasmVNC (:3000) to otforge-attack-base noVNC (:6080)
    expect(attackCompose().services['kali-1'].ports).toContain('6900:6080')
  })

  it('assigns sequential host ports to multiple attack machines — 6900, 6901, etc.', () => {
    const compose = gen(
      makeScenario([
        ['kali-1', { category: 'attack-machine', ipAddress: '10.200.60.10' }],
        ['kali-2', { category: 'attack-machine', ipAddress: '10.200.60.11' }]
      ])
    )
    expect(compose.services['kali-1'].ports).toContain('6900:6080')
    expect(compose.services['kali-2'].ports).toContain('6901:6080')
  })

  it('sets dns: to the dns-server device IP when one is present in the scenario', () => {
    const scenario = makeScenario(
      [
        ['kali-1', { category: 'attack-machine', ipAddress: '10.200.60.10' }],
        ['dns-1', { category: 'dns-server', ipAddress: '10.200.50.5' }]
      ],
      [
        { zone: 'attacker', subnet: '10.200.60.0/24', gateway: '10.200.60.1' },
        { zone: 'internet-dmz', subnet: '10.200.50.0/24', gateway: '10.200.50.1' }
      ]
    )
    const compose = gen(scenario)
    // dns: field must include the scenario dns-server IP first, then 8.8.8.8 as a public
    // fallback so Kali can resolve external names via attacker-net even when the scenario's
    // DNS server is air-gapped (DNS_UPSTREAM="").
    expect((compose.services['kali-1'] as { dns?: string[] }).dns).toEqual([
      '10.200.50.5',
      '8.8.8.8'
    ])
  })

  it('does NOT set dns: when no dns-server device is in the scenario', () => {
    const compose = attackCompose()
    expect((compose.services['kali-1'] as { dns?: string[] }).dns).toBeUndefined()
  })
})

// ── PLC port publishing ───────────────────────────────────────────────────────

describe('PLC port publishing', () => {
  it('publishes OpenPLC web UI on host port 18080 for the first PLC', () => {
    const compose = gen(makeScenario([['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]]))
    expect(compose.services['plc-1'].ports).toContain('18080:8080')
  })

  it('assigns sequential host ports to multiple PLCs — 18080, 18081, etc.', () => {
    // Object.entries() preserves insertion order (V8 guarantee for string keys),
    // mirroring the same ordering used by main/index.ts to build activePlcPorts.
    const compose = gen(
      makeScenario([
        ['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }],
        ['plc-2', { category: 'plc', ipAddress: '10.200.10.11' }]
      ])
    )
    expect(compose.services['plc-1'].ports).toContain('18080:8080')
    expect(compose.services['plc-2'].ports).toContain('18081:8080')
  })

  it('does not publish any ports for non-PLC devices', () => {
    const compose = gen(makeScenario([['rtu-1', { category: 'rtu', ipAddress: '10.200.10.10' }]]))
    expect(compose.services['rtu-1'].ports).toBeUndefined()
  })
})

// ── Environment variable injection ────────────────────────────────────────────

describe('environment variable injection', () => {
  it('always injects DEVICE_ID and DEVICE_CATEGORY for every device', () => {
    const compose = gen(makeScenario([['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]]))
    const env = compose.services['plc-1'].environment ?? []
    expect(env).toContain('DEVICE_ID=plc-1')
    expect(env).toContain('DEVICE_CATEGORY=plc')
  })

  it('injects MODBUS_MODE, MODBUS_PORT, MODBUS_UNIT_ID when a Modbus config is present', () => {
    const compose = gen(
      makeScenario([
        [
          'rtu-1',
          {
            category: 'rtu',
            ipAddress: '10.200.10.10',
            modbus: { mode: 'tcp', port: 502, unitId: 5, registers: {} }
          }
        ]
      ])
    )
    const env = compose.services['rtu-1'].environment ?? []
    expect(env).toContain('MODBUS_MODE=tcp')
    expect(env).toContain('MODBUS_PORT=502')
    expect(env).toContain('MODBUS_UNIT_ID=5')
  })

  it('injects SENSOR_* vars when a smart-sensor config is present', () => {
    const compose = gen(
      makeScenario([
        [
          'sensor-1',
          {
            category: 'smart-sensor',
            ipAddress: '10.200.10.10',
            sensor: {
              kind: 'flow',
              waveform: 'sawtooth',
              minValue: 0,
              maxValue: 300,
              noisePercent: 5,
              modbusRegister: 12
            }
          }
        ]
      ])
    )
    const env = compose.services['sensor-1'].environment ?? []
    expect(env).toContain('SENSOR_KIND=flow')
    expect(env).toContain('SENSOR_WAVEFORM=sawtooth')
    expect(env).toContain('SENSOR_MIN_VALUE=0')
    expect(env).toContain('SENSOR_MAX_VALUE=300')
    expect(env).toContain('SENSOR_NOISE_PERCENT=5')
    expect(env).toContain('SENSOR_MODBUS_REGISTER=12')
  })

  it('injects DNP3_* vars when a DNP3 config is present', () => {
    const compose = gen(
      makeScenario([
        [
          'ied-1',
          {
            category: 'ied',
            ipAddress: '10.200.10.10',
            dnp3: { masterAddress: 1, outstationAddress: 10, port: 20000 }
          }
        ]
      ])
    )
    const env = compose.services['ied-1'].environment ?? []
    expect(env).toContain('DNP3_MASTER_ADDRESS=1')
    expect(env).toContain('DNP3_OUTSTATION_ADDRESS=10')
    expect(env).toContain('DNP3_PORT=20000')
  })

  it('injects OPCUA_PORT and OPCUA_NAMESPACE when an OPC-UA config is present', () => {
    const compose = gen(
      makeScenario([
        [
          'plc-1',
          {
            category: 'plc',
            ipAddress: '10.200.10.10',
            opcua: { port: 4840, namespace: 'urn:icslab:plc', nodes: [] }
          }
        ]
      ])
    )
    const env = compose.services['plc-1'].environment ?? []
    expect(env).toContain('OPCUA_PORT=4840')
    expect(env).toContain('OPCUA_NAMESPACE=urn:icslab:plc')
  })

  it('injects INITIAL_PROGRAM_B64 when a saved PLC program source exists', () => {
    const b64 = Buffer.from('PROGRAM main VAR END_VAR END_PROGRAM').toString('base64')
    const compose = gen(
      makeScenario([
        [
          'plc-1',
          {
            category: 'plc',
            ipAddress: '10.200.10.10',
            plcProgram: {
              language: 'st',
              source: b64,
              variables: [
                {
                  name: 'pressure',
                  type: 'REAL',
                  address: '%IW0',
                  protocol: 'modbus-tcp',
                  protocolAddress: '0'
                }
              ]
            }
          }
        ]
      ])
    )
    const env = compose.services['plc-1'].environment ?? []
    expect(env).toContain(`INITIAL_PROGRAM_B64=${b64}`)
  })

  it('injects PLC_VAR_COUNT equal to the number of variable bindings', () => {
    const b64 = Buffer.from('PROGRAM main VAR END_VAR END_PROGRAM').toString('base64')
    const compose = gen(
      makeScenario([
        [
          'plc-1',
          {
            category: 'plc',
            ipAddress: '10.200.10.10',
            plcProgram: {
              language: 'st',
              source: b64,
              variables: [
                {
                  name: 'v1',
                  type: 'BOOL',
                  address: '%IX0.0',
                  protocol: 'modbus-tcp',
                  protocolAddress: '0'
                },
                {
                  name: 'v2',
                  type: 'BOOL',
                  address: '%QX0.0',
                  protocol: 'modbus-tcp',
                  protocolAddress: '0'
                }
              ]
            }
          }
        ]
      ])
    )
    const env = compose.services['plc-1'].environment ?? []
    expect(env).toContain('PLC_VAR_COUNT=2')
  })

  it('does NOT inject INITIAL_PROGRAM_B64 when plcProgram has no source', () => {
    const compose = gen(makeScenario([['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]]))
    const env = compose.services['plc-1'].environment ?? []
    expect(env.some(v => v.startsWith('INITIAL_PROGRAM_B64'))).toBe(false)
  })
})

// ── DNS device env vars ───────────────────────────────────────────────────────

describe('DNS device environment variable injection', () => {
  it('injects DNS_DOMAIN when device.dns.domain is set', () => {
    const compose = gen(
      makeScenario([
        [
          'dns-1',
          {
            category: 'dns-server',
            ipAddress: '10.200.50.10',
            dns: { domain: 'ics-lab.local', webServerIp: '', upstream: '8.8.8.8' }
          }
        ]
      ])
    )
    const env = compose.services['dns-1'].environment ?? []
    expect(env).toContain('DNS_DOMAIN=ics-lab.local')
  })

  it('injects WEB_SERVER_IP when device.dns.webServerIp is set', () => {
    const compose = gen(
      makeScenario([
        [
          'dns-1',
          {
            category: 'dns-server',
            ipAddress: '10.200.50.10',
            dns: { domain: 'test.com', webServerIp: '10.200.50.11', upstream: '' }
          }
        ]
      ])
    )
    const env = compose.services['dns-1'].environment ?? []
    expect(env).toContain('WEB_SERVER_IP=10.200.50.11')
  })

  it('injects DNS_UPSTREAM=8.8.8.8 when upstream is "8.8.8.8"', () => {
    const compose = gen(
      makeScenario([
        [
          'dns-1',
          {
            category: 'dns-server',
            ipAddress: '10.200.50.10',
            dns: { domain: '', webServerIp: '', upstream: '8.8.8.8' }
          }
        ]
      ])
    )
    const env = compose.services['dns-1'].environment ?? []
    expect(env).toContain('DNS_UPSTREAM=8.8.8.8')
  })

  it('injects DNS_UPSTREAM= (empty) when upstream is "" — triggers air-gapped mode', () => {
    // Empty string upstream is meaningful (air-gapped DNS — no public forwarding).
    // The inject must use !== undefined so "" is preserved, not skipped.
    const compose = gen(
      makeScenario([
        [
          'dns-1',
          {
            category: 'dns-server',
            ipAddress: '10.200.50.10',
            dns: { domain: '', webServerIp: '', upstream: '' }
          }
        ]
      ])
    )
    const env = compose.services['dns-1'].environment ?? []
    expect(env).toContain('DNS_UPSTREAM=')
  })

  it('does NOT inject DNS_UPSTREAM when upstream is undefined', () => {
    const compose = gen(
      makeScenario([
        [
          'dns-1',
          {
            category: 'dns-server',
            ipAddress: '10.200.50.10',
            dns: { domain: '', webServerIp: '' }
          }
        ]
      ])
    )
    const env = compose.services['dns-1'].environment ?? []
    expect(env.some(v => v.startsWith('DNS_UPSTREAM'))).toBe(false)
  })
})

// ── Process unit env vars (pipeline + generator) ──────────────────────────────

describe('process unit environment variable injection', () => {
  it('injects PIPELINE_VOLUME_L and PIPELINE_PUMP_MAX_LPM for pipeline units', () => {
    const compose = gen(
      makeScenario([
        [
          'pipe-1',
          {
            category: 'process-unit',
            ipAddress: '10.200.10.20',
            processUnit: {
              processType: 'pipeline',
              pipelineVolumeL: 5000,
              pipelinePumpMaxLpm: 300
            }
          }
        ]
      ])
    )
    const env = compose.services['pipe-1'].environment ?? []
    expect(env).toContain('PROCESS_TYPE=pipeline')
    expect(env).toContain('PIPELINE_VOLUME_L=5000')
    expect(env).toContain('PIPELINE_PUMP_MAX_LPM=300')
  })

  it('injects GENERATOR_RATED_MW, GENERATOR_INERTIA_H, GENERATOR_FREQ_BASE for generator units', () => {
    const compose = gen(
      makeScenario([
        [
          'gen-1',
          {
            category: 'process-unit',
            ipAddress: '10.200.10.20',
            processUnit: {
              processType: 'generator',
              generatorRatedMw: 100,
              generatorInertiaH: 5,
              generatorFreqBase: 60
            }
          }
        ]
      ])
    )
    const env = compose.services['gen-1'].environment ?? []
    expect(env).toContain('GENERATOR_RATED_MW=100')
    expect(env).toContain('GENERATOR_INERTIA_H=5')
    expect(env).toContain('GENERATOR_FREQ_BASE=60')
  })

  it('omits optional process unit vars when not set', () => {
    const compose = gen(
      makeScenario([
        [
          'tank-1',
          {
            category: 'process-unit',
            ipAddress: '10.200.10.20',
            processUnit: { processType: 'water-tank' }
          }
        ]
      ])
    )
    const env = compose.services['tank-1'].environment ?? []
    expect(env).toContain('PROCESS_TYPE=water-tank')
    expect(env.some(v => v.startsWith('PIPELINE_'))).toBe(false)
    expect(env.some(v => v.startsWith('GENERATOR_'))).toBe(false)
  })
})

// ── S7 / IEC 104 / BACnet env vars ───────────────────────────────────────────

describe('legacy protocol environment variable injection', () => {
  it('injects S7_DEVICE_TYPE and S7_PORT for S7 devices', () => {
    const compose = gen(
      makeScenario([
        [
          's7-1',
          {
            category: 'legacy-plc',
            ipAddress: '10.200.10.10',
            s7: { deviceType: '300', rack: 0, slot: 2, port: 102 }
          }
        ]
      ])
    )
    const env = compose.services['s7-1'].environment ?? []
    expect(env).toContain('S7_DEVICE_TYPE=300')
    expect(env).toContain('S7_PORT=102')
  })

  it('injects IEC104_COMMON_ADDRESS and IEC104_PORT for IEC 104 RTU devices', () => {
    const compose = gen(
      makeScenario([
        [
          'rtu-1',
          {
            category: 'iec104-rtu',
            ipAddress: '10.200.10.10',
            iec104: { commonAddress: 7, port: 2404 }
          }
        ]
      ])
    )
    const env = compose.services['rtu-1'].environment ?? []
    expect(env).toContain('IEC104_COMMON_ADDRESS=7')
    expect(env).toContain('IEC104_PORT=2404')
  })

  it('injects BACNET_DEVICE_INSTANCE and BACNET_PORT for BACnet devices', () => {
    const compose = gen(
      makeScenario([
        [
          'bacnet-1',
          {
            category: 'sensor',
            ipAddress: '10.200.10.10',
            bacnet: { deviceInstance: 1001, port: 47808 }
          }
        ]
      ])
    )
    const env = compose.services['bacnet-1'].environment ?? []
    expect(env).toContain('BACNET_DEVICE_INSTANCE=1001')
    expect(env).toContain('BACNET_PORT=47808')
  })

  it('uses default BACnet port 47808 when port is not specified', () => {
    const compose = gen(
      makeScenario([
        [
          'bacnet-1',
          {
            category: 'sensor',
            ipAddress: '10.200.10.10',
            bacnet: { deviceInstance: 42 }
          }
        ]
      ])
    )
    const env = compose.services['bacnet-1'].environment ?? []
    expect(env).toContain('BACNET_PORT=47808')
  })

  it('injects BACNET_KIND for a building-automation equipment kind', () => {
    const compose = gen(
      makeScenario([
        [
          'ahu-1',
          {
            category: 'sensor',
            ipAddress: '10.200.10.10',
            bacnet: { deviceInstance: 1002, kind: 'ahu' }
          }
        ]
      ])
    )
    const env = compose.services['ahu-1'].environment ?? []
    expect(env).toContain('BACNET_KIND=ahu')
  })

  it('defaults BACNET_KIND to generic when kind is not specified (pre-existing scenarios)', () => {
    const compose = gen(
      makeScenario([
        [
          'bacnet-1',
          {
            category: 'sensor',
            ipAddress: '10.200.10.10',
            bacnet: { deviceInstance: 1001 }
          }
        ]
      ])
    )
    const env = compose.services['bacnet-1'].environment ?? []
    expect(env).toContain('BACNET_KIND=generic')
  })
})

// ── WS_PLC_WEBUIS workstation + PLC injection ─────────────────────────────────

describe('WS_PLC_WEBUIS injection', () => {
  it('injects WS_PLC_WEBUIS into workstation env when a PLC is in the scenario', () => {
    const compose = gen(
      makeScenario([
        ['ws-1', { category: 'engineering-workstation', ipAddress: '10.200.20.50' }],
        ['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]
      ])
    )
    const env = compose.services['ws-1'].environment ?? []
    const entry = env.find(v => v.startsWith('WS_PLC_WEBUIS='))
    expect(entry).toBeDefined()
    expect(entry).toContain('plc-1|http://10.200.10.10:8080')
  })

  it('includes all PLCs in WS_PLC_WEBUIS when multiple PLCs are present', () => {
    const compose = gen(
      makeScenario([
        ['ws-1', { category: 'engineering-workstation', ipAddress: '10.200.20.50' }],
        ['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }],
        ['plc-2', { category: 'plc', ipAddress: '10.200.10.11' }]
      ])
    )
    const env = compose.services['ws-1'].environment ?? []
    const entry = env.find(v => v.startsWith('WS_PLC_WEBUIS='))
    expect(entry).toBeDefined()
    expect(entry).toContain('plc-1|http://10.200.10.10:8080')
    expect(entry).toContain('plc-2|http://10.200.10.11:8080')
  })

  it('does NOT inject WS_PLC_WEBUIS when no PLCs are in the scenario', () => {
    const compose = gen(
      makeScenario([
        ['ws-1', { category: 'engineering-workstation', ipAddress: '10.200.20.50' }],
        ['rtu-1', { category: 'rtu', ipAddress: '10.200.10.10' }]
      ])
    )
    const env = compose.services['ws-1'].environment ?? []
    expect(env.some(v => v.startsWith('WS_PLC_WEBUIS='))).toBe(false)
  })

  it('injects WS_PLC_WEBUIS into all workstations when multiple are present', () => {
    const compose = gen(
      makeScenario([
        ['ws-1', { category: 'engineering-workstation', ipAddress: '10.200.20.50' }],
        ['ws-2', { category: 'engineering-workstation', ipAddress: '10.200.20.51' }],
        ['plc-1', { category: 'plc', ipAddress: '10.200.10.10' }]
      ])
    )
    for (const wsKey of ['ws-1', 'ws-2']) {
      const env = compose.services[wsKey].environment ?? []
      expect(env.some(v => v.startsWith('WS_PLC_WEBUIS='))).toBe(true)
    }
  })
})

// ── Fixed infrastructure services ─────────────────────────────────────────────

describe('fixed infrastructure services', () => {
  // Infrastructure runs in every simulation regardless of scenario contents.
  // Using a single-sensor scenario as the minimal base.
  const infraScenario = makeScenario([['s1', { category: 'sensor', ipAddress: '10.200.10.10' }]])

  it('always includes Suricata IDS/IPS', () => {
    expect(gen(infraScenario).services).toHaveProperty('suricata')
  })

  it('always includes Zeek passive network analysis', () => {
    expect(gen(infraScenario).services).toHaveProperty('zeek')
  })

  it('always includes InfluxDB for the process historian', () => {
    expect(gen(infraScenario).services).toHaveProperty('influxdb')
  })

  it('always includes Loki for log aggregation', () => {
    expect(gen(infraScenario).services).toHaveProperty('loki')
  })

  it('always includes Grafana for dashboards', () => {
    expect(gen(infraScenario).services).toHaveProperty('grafana')
  })

  it('always includes FUXA for the HMI', () => {
    expect(gen(infraScenario).services).toHaveProperty('fuxa')
  })

  it('creates named volumes for all infrastructure services that need persistence', () => {
    const compose = gen(infraScenario, 'my-proj')
    expect(compose.volumes).toHaveProperty('my-proj-suricata-logs')
    expect(compose.volumes).toHaveProperty('my-proj-zeek-logs')
    expect(compose.volumes).toHaveProperty('my-proj-influxdb-data')
    expect(compose.volumes).toHaveProperty('my-proj-loki-data')
    expect(compose.volumes).toHaveProperty('my-proj-grafana-data')
    expect(compose.volumes).toHaveProperty('my-proj-fuxa-data')
  })

  it('places infrastructure services on control-net (Level 3 — Control Center)', () => {
    const compose = gen(infraScenario)
    // InfluxDB, Loki, Grafana, FUXA all live in the Control Center zone (L3)
    expect(compose.services['influxdb'].networks).toHaveProperty('control-net')
    expect(compose.services['loki'].networks).toHaveProperty('control-net')
    expect(compose.services['grafana'].networks).toHaveProperty('control-net')
    expect(compose.services['fuxa'].networks).toHaveProperty('control-net')
  })

  it('grants Suricata NET_ADMIN + NET_RAW for AF_PACKET raw socket capture', () => {
    const compose = gen(infraScenario)
    expect(compose.services['suricata'].cap_add).toContain('NET_ADMIN')
    expect(compose.services['suricata'].cap_add).toContain('NET_RAW')
  })

  it('runs Suricata in host network mode for AF_PACKET bridge interface access', () => {
    const compose = gen(infraScenario)
    // Suricata uses network_mode: 'host' so it can open AF_PACKET sockets on the
    // br-XXXX Docker bridge interfaces — per-network IP assignments are not used.
    expect(compose.services['suricata'].network_mode).toBe('host')
  })
})

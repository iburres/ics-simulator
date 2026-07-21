/**
 * ScadaCanvas.tsx — React Flow SCADA topology canvas, layer-tab model.
 *
 * One canvas scoped to the active Purdue layer tab (OT Process, IT Network,
 * DMZ, External). Nodes and edges for all layers live in the scenario document;
 * this component displays only the subset that belongs to the active layer.
 *
 * Layer-tab model vs. the old zone-band model:
 *   - No more zone background rectangles (ZoneNode) — each tab IS the zone.
 *   - Zone assignment comes from the activeLayer prop, not y-coordinate lookup.
 *   - Edges are filtered so only connections between nodes in the current layer
 *     are visible on this tab.
 *   - Position persistence: onNodeDragStop writes updated positions back to the
 *     scenario so they survive tab switches.
 *
 * OT Process tab visual differences:
 *   - Dark P&ID background (#060d14) with fine grid lines (BackgroundVariant.Lines)
 *   - PipeEdge (orthogonal routing, 3 px, filled arrowhead) instead of ProtocolEdge
 *   - Slightly wider fitView padding to show spacing between field devices
 *
 * All other tabs (IT, DMZ, External) keep the standard dark dot-grid style and
 * bezier ProtocolEdge connectors.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  addEdge,
  reconnectEdge,
  useNodesState,
  useEdgesState,
  BackgroundVariant,
  type NodeTypes,
  type EdgeTypes,
  type OnConnect,
  type Connection,
  type Node,
  type Edge,
  type ReactFlowInstance,
  type OnSelectionChangeParams,
  type OnNodeDrag
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type {
  OTForgeScenario,
  DeviceCategory,
  NetworkZone,
  DeviceConfig,
  Protocol,
  CableType,
  FluidType,
  RtuConfig,
  SiteRegion,
  CanvasNode,
  ControllerConfig,
  SensorConfig
} from '@otforge/schema'
import {
  DeviceNode,
  type DeviceNodeData,
  type DeviceNodeType,
  type CrossLayerLink,
  ZONE_COLORS
} from './DeviceNode'
import { SiteNode, type SiteNodeType, type SiteNodeData } from './SiteNode'
import { ProtocolEdge, type ProtocolEdgeType } from './ProtocolEdge'
import { PipeEdge, type PipeEdgeType } from './PipeEdge'
import {
  getSourceProtocols,
  isConnectionValid,
  getRejectionReason,
  getSourceCables,
  isCableValid,
  getCableRejectionReason,
  isProtocolCableCompatible
} from './connectionRules'
import { DEFAULT_SENSOR_CONFIG } from '../properties/SensorPanel'
import { DEFAULT_CONTROLLER_CONFIG } from '../properties/ControllerPanel'
import { DEFAULT_BACNET_CONFIG } from '../properties/BacnetPanel'

/**
 * Protocol options shown in the "Application Protocol" section of the connection menu.
 * Each entry maps a schema Protocol value to a human-readable label and accent color.
 */
const CONNECTION_OPTIONS: { protocol: Protocol; label: string; color: string }[] = [
  { protocol: 'modbus-tcp', label: 'Modbus TCP', color: '#39d0b0' },
  { protocol: 'modbus-rtu', label: 'Modbus RTU', color: '#39d0b0' },
  { protocol: 'modbus-ascii', label: 'Modbus ASCII', color: '#39d0b0' },
  { protocol: 'dnp3', label: 'DNP3', color: '#388bfd' },
  { protocol: 'opc-ua', label: 'OPC-UA', color: '#d29922' },
  { protocol: 'bacnet', label: 'BACnet', color: '#d29922' },
  { protocol: 'ethernet-ip', label: 'EtherNet/IP', color: '#f85149' },
  { protocol: 'iec61850', label: 'IEC 61850', color: '#a371f7' },
  { protocol: 'mqtt', label: 'MQTT', color: '#e87040' },
  { protocol: 'none', label: 'Unspecified / Ethernet', color: '#484f58' }
]

/**
 * Fluid type options shown in the "Fluid Type" section of the OT-layer connection menu.
 * Selecting a fluid type is OPTIONAL — the pipe is created regardless.
 * When a fluid type is pre-selected, it is stored on the edge and drives the animated
 * substance icons in PipeEdge.tsx once the simulation is running.
 */
const FLUID_OPTIONS: { fluid: FluidType; label: string; color: string }[] = [
  { fluid: 'water', label: 'Water / Process Water', color: '#38bdf8' },
  { fluid: 'oil', label: 'Oil / Hydraulic Fluid', color: '#78350f' },
  { fluid: 'gas', label: 'Gas / Steam / Pneumatic Air', color: '#94a3b8' },
  { fluid: 'chemical', label: 'Chemical / Reagent', color: '#4ade80' },
  { fluid: 'electric', label: 'Electrical Signal / Power', color: '#facc15' }
]

/**
 * Physical cable options shown in the "Physical Cable" section of the connection menu.
 * Selecting a cable type is OPTIONAL — the connection proceeds even if no cable is chosen.
 * When a cable is pre-selected and the user then clicks a protocol, both are stored on
 * the new edge and rendered as two stacked label chips.
 */
const CABLE_OPTIONS: { cable: CableType; label: string; color: string }[] = [
  { cable: 'cat5e', label: 'Cat5e Ethernet (100M)', color: '#58a6ff' },
  { cable: 'cat6', label: 'Cat6 Ethernet (1G)', color: '#58a6ff' },
  { cable: 'cat6a', label: 'Cat6a Ethernet (10G)', color: '#79c0ff' },
  { cable: 'smf', label: 'Fiber — SMF (long run)', color: '#e3b341' },
  { cable: 'mmf', label: 'Fiber — MMF (in-building)', color: '#e3b341' },
  { cable: 'rs232', label: 'Serial RS-232 (console)', color: '#c9a227' },
  { cable: 'rs485', label: 'Serial RS-485 (field bus)', color: '#c9a227' },
  { cable: 'wifi', label: 'Wi-Fi 802.11 / WirelessHART', color: '#3dc9b0' },
  { cable: 'sata', label: 'SATA Storage Interface', color: '#8b5cf6' },
  { cable: 'ac', label: 'AC Power', color: '#ff7b72' },
  { cable: 'dc', label: 'DC Power (24 VDC)', color: '#ff7b72' }
]

/**
 * Short abbreviations for each Purdue zone — used on cross-layer stub badges.
 * Kept to ≤ 5 characters so they fit in the compact badge without wrapping.
 */
const ZONE_ABBREVS: Record<NetworkZone, string> = {
  ot: 'OT',
  control: 'CTRL',
  'plant-dmz': 'DMZ',
  enterprise: 'ENT',
  'internet-dmz': 'iDMZ',
  attacker: 'ATK'
}

/** State shape for the right-click connection context menu. */
interface ContextMenuState {
  /** ID of the source device node that was right-clicked. */
  nodeId: string
  /** Viewport X coordinate for menu placement (used with position: fixed). */
  x: number
  /** Viewport Y coordinate for menu placement (used with position: fixed). */
  y: number
  /**
   * Cable type pre-selected from the Physical Cable section of the menu.
   * Set by clicking a cable item (which toggles selection and keeps the menu open).
   * Carried into PendingConnectionState when the user then clicks a protocol item.
   */
  pendingCable?: CableType
  /**
   * Fluid type pre-selected from the Fluid Type section of the OT-layer menu.
   * Carried into PendingConnectionState when the user clicks a protocol item.
   * Drives the animated substance icons on the resulting PipeEdge.
   */
  pendingFluid?: FluidType
  /**
   * When true, the context menu renders its "Freehand Connection" sub-view instead
   * of the normal protocol/cable list. The user types a custom label, picks any
   * fluid type, then clicks "Draw Freehand" to start the edge — no Purdue-model
   * validation is applied when they click the target node.
   */
  freehandMode?: boolean
  /**
   * Custom label text typed by the user in freehand mode.
   * Written into the resulting edge's data.label field.
   */
  pendingLabel?: string
}

/**
 * State shape for a pending two-click edge connection.
 * Set when the user picks a protocol from the context menu; cleared when they
 * click a target node or press Escape.
 */
interface PendingConnectionState {
  /** The node that was right-clicked — becomes the edge source. */
  sourceId: string
  /** Protocol selected from the menu — written into the new edge's data. */
  protocol: Protocol
  /**
   * Physical cable type pre-selected before the protocol was clicked (optional).
   * Undefined when the user only selected a protocol without choosing a cable.
   */
  cableType?: CableType
  /**
   * Fluid type pre-selected from the OT-layer menu (optional).
   * Written into the new PipeEdge's data.fluidType field.
   */
  fluidType?: FluidType
  /**
   * When true, Purdue-model / connection-rules validation is skipped entirely.
   * The user can connect any two nodes on the canvas with any fluid type and label.
   * Set by the "Draw Freehand Connection" option in the right-click context menu.
   */
  freehand?: boolean
  /**
   * Custom label text supplied in freehand mode.
   * Written into the resulting edge's data.label field verbatim.
   */
  freeLabel?: string
}

/** Registration map: React Flow node type key → component. */
const nodeTypes: NodeTypes = {
  deviceNode: DeviceNode,
  siteNode: SiteNode
}

/**
 * Registration map: React Flow edge type key → component.
 * Both edge types registered so the canvas can handle scenarios that mix
 * edges created on different layer tabs.
 */
const edgeTypes: EdgeTypes = {
  protocolEdge: ProtocolEdge,
  pipeEdge: PipeEdge
}

/**
 * Fixed cell size in flow-units (pixels at zoom = 1).
 * Device nodes occupy exactly one cell; the snap grid and background gap both
 * use this value so nodes always align precisely with the visible grid lines.
 * Exported so the DeviceNode CSS and any other canvas consumers stay in sync.
 */
export const CELL_SIZE = 80

/** Default canvas is 25 columns × 25 rows of CELL_SIZE cells. */
const GRID_COLS = 25
const GRID_ROWS = 25

/** Total canvas extent in flow-units. Used as the fitBounds target rect. */
const CANVAS_W = GRID_COLS * CELL_SIZE // 2000 px at zoom = 1
const CANVAS_H = GRID_ROWS * CELL_SIZE // 2000 px at zoom = 1

/**
 * Bounding box for the full 25 × 25 canvas area.
 * Every fitBounds call targets this rect so the initial view always shows
 * the complete grid with a small margin.
 */
const CANVAS_BOUNDS = { x: 0, y: 0, width: CANVAS_W, height: CANVAS_H }

/**
 * Fits visible nodes into view (empty canvas → full grid). Used on mount,
 * layer switch, window resize, and empty-scenario placeholder.
 */
function fitCanvasView(instance: ReactFlowInstance): void {
  void (async () => {
    if (instance.getNodes().length === 0) {
      await instance.fitBounds(CANVAS_BOUNDS, { padding: 0.04, duration: 0 })
      return
    }
    await instance.fitView({ padding: 0.2, duration: 0 })
    await instance.zoomTo(instance.getZoom() / (1.2 * 1.2), { duration: 0 })
  })()
}

/**
 * True when two React Flow nodes would render the same on canvas.
 * Used to keep object identity across scenario sync so edge handle bounds stay valid.
 */
function nodeRenderEqual(a: Node, b: Node): boolean {
  if (a.type !== b.type) return false
  if (a.type === 'siteNode') {
    const ar = (a.data as SiteNodeData).region
    const br = (b.data as SiteNodeData).region
    return (
      ar.id === br.id &&
      ar.label === br.label &&
      ar.color === br.color &&
      ar.width === br.width &&
      ar.height === br.height &&
      ar.zone === br.zone &&
      (a.data as SiteNodeData).readOnly === (b.data as SiteNodeData).readOnly
    )
  }
  const ad = a.data as DeviceNodeData
  const bd = b.data as DeviceNodeData
  return (
    ad.zone === bd.zone &&
    ad.label === bd.label &&
    ad.device.category === bd.device.category &&
    ad.device.ipAddress === bd.device.ipAddress &&
    (ad.device.label ?? '') === (bd.device.label ?? '') &&
    (ad.device.sensor?.kind ?? '') === (bd.device.sensor?.kind ?? '') &&
    (ad.device.controller?.kind ?? '') === (bd.device.controller?.kind ?? '')
  )
}

/** displayNodes also layers className / fillLevel / cross-layer stubs onto nodes. */
function displayNodeEqual(a: Node, b: Node): boolean {
  if (a.className !== b.className) return false
  if (a.position.x !== b.position.x || a.position.y !== b.position.y) return false
  if (!!a.selected !== !!b.selected) return false
  if (!nodeRenderEqual(a, b)) return false
  if (a.type === 'siteNode') return true
  const ad = a.data as DeviceNodeData
  const bd = b.data as DeviceNodeData
  if ((ad.fillLevel ?? -1) !== (bd.fillLevel ?? -1)) return false
  const az =
    ad.crossLayerLinks
      ?.map(l => l.zone)
      .slice()
      .sort()
      .join(',') ?? ''
  const bz =
    bd.crossLayerLinks
      ?.map(l => l.zone)
      .slice()
      .sort()
      .join(',') ?? ''
  return az === bz
}

/**
 * Default IP address for newly dropped devices, by zone.
 *
 * Must match ZONE_DEFAULTS in packages/orchestrator/src/network-config.ts — both
 * use 10.200.x.x so devices land inside the Docker bridge network on first drop.
 * Users can override in PropertiesPanel; the compose generator will also translate
 * these IPs if subnet auto-detection picks a different range at simulation start.
 *
 * Third octets: OT=10, Control=20, PlantDMZ=30, Enterprise=40, InternetDMZ=50, Attacker=60
 */
const DEFAULT_IP: Record<NetworkZone, string> = {
  ot: '10.200.10.10',
  control: '10.200.20.10',
  'plant-dmz': '10.200.30.10',
  enterprise: '10.200.40.10',
  'internet-dmz': '10.200.50.10',
  attacker: '10.200.60.10'
}

/**
 * Returns the lowest unused host address in the given zone, starting from .10.
 *
 * Looks at every device currently in the scenario, collects the host octets
 * (last octet) of IPs that share the same /24 prefix as the zone default, and
 * increments until it finds a gap. This prevents duplicate IPs when two or more
 * devices are dropped onto the same zone — Docker rejects any compose file that
 * assigns the same IP to multiple containers on the same bridge network.
 *
 * @param zone    - The Purdue zone the new device will join.
 * @param devices - All devices already present in the scenario.
 * @returns A unique IPv4 string within the zone's /24 subnet, e.g. "10.200.10.11".
 */
function nextAvailableIp(zone: NetworkZone, devices: Record<string, DeviceConfig>): string {
  const base = DEFAULT_IP[zone] // e.g. "10.200.10.10"
  const prefix = base.substring(0, base.lastIndexOf('.') + 1) // e.g. "10.200.10."

  // Collect host octets already in use on this zone's subnet
  const used = new Set<number>()
  for (const d of Object.values(devices)) {
    if (d.ipAddress.startsWith(prefix)) {
      const host = parseInt(d.ipAddress.split('.')[3], 10)
      if (!isNaN(host)) used.add(host)
    }
  }

  // .10–.239 are available for user devices.
  // .240–.249 are reserved for system services (influxdb, loki, grafana, fuxa, promtail).
  // .250–.254 are reserved for network infrastructure (zeek .252, suricata .253, firewall .254).
  let host = 10
  while (used.has(host) && host < 240) host++
  return `${prefix}${host}`
}

/**
 * Default protocol assignments for newly created devices by category.
 * Matches the container images: Modbus for PLCs/RTUs/field devices,
 * DNP3 for IEDs, no protocol for infrastructure and IT devices.
 */
const DEFAULT_PROTOCOLS: Record<DeviceCategory, Protocol[]> = {
  // ── OT Process ──────────────────────────────────────────────────────────────
  plc: ['modbus-tcp'],
  rtu: ['modbus-rtu'],
  ied: ['dnp3'],
  'iec61850-ied': ['iec61850'],
  'ethernetip-adapter': ['ethernet-ip'], // real otforge-ethernetip container, scanned by a PLC
  'profinet-device': ['profinet'], // real otforge-profinet container (DCP only), scanned by a PLC
  'safety-plc': ['modbus-tcp'], // SIS — same Modbus transport as standard PLC
  'dcs-controller': ['opc-ua'], // DCS prefers OPC-UA upward by convention
  'legacy-plc': ['s7comm'], // Siemens S7 — S7comm primary protocol (Phase 10)
  'iec104-rtu': ['iec-104'], // IEC 60870-5-104 RTU (Phase 10)
  'process-unit': ['modbus-tcp'], // physics process sim — Modbus TCP server (Phase 11)
  // 'sensor' always runs the real otforge-bacnet container (see DEVICE_IMAGES in
  // compose-generator.ts) — the previous 'modbus-tcp' default here was stale/never
  // matched what actually gets deployed.
  sensor: ['bacnet'],
  'iiot-sensor': ['mqtt'], // wireless IIoT sensor publishes MQTT
  'iot-gateway': ['mqtt'], // gateway bridges MQTT ↔ OPC-UA/historian
  'smart-sensor': ['modbus-tcp'], // real otforge-modbus container → PLC via Modbus TCP
  'smart-controller': ['modbus-tcp'], // real pymodbus container → PLC via Modbus TCP
  // ── Control Center (L3) ─────────────────────────────────────────────────────
  hmi: ['none'],
  historian: ['none'],
  'scada-server': ['none'],
  'application-server': ['none'],
  'database-server': ['none'],
  'engineering-workstation': ['none'],
  // ── Plant DMZ (L3.5) ────────────────────────────────────────────────────────
  firewall: ['none'],
  'ids-ips': ['none'],
  switch: ['none'],
  router: ['none'],
  'jump-server': ['none'],
  'data-diode': ['none'],
  wap: ['none'],
  // ── Enterprise (L4) ─────────────────────────────────────────────────────────
  'domain-controller': ['none'],
  'web-server': ['none'],
  'business-server': ['none'],
  'enterprise-desktop': ['none'],
  // ── Internet DMZ (L5) ───────────────────────────────────────────────────────
  'email-server': ['none'],
  'internet-server': ['none'],
  'dns-server': ['none'], // authoritative DNS server — meridian-process.com zone (Phase 12)
  'ip-camera': ['none'], // real otforge-camera container — SSH is the attack surface, not an ICS protocol
  // ── Red Team ─────────────────────────────────────────────────────────────────
  'attack-machine': ['none']
}

/** Short display labels for device nodes on the canvas. */
const CATEGORY_LABELS: Record<DeviceCategory, string> = {
  // ── OT Process (L0–L2) ──────────────────────────────────────────────────────
  plc: 'PLC',
  rtu: 'RTU',
  ied: 'IED',
  'iec61850-ied': 'IEC 61850 IED',
  'ethernetip-adapter': 'EtherNet/IP Adapter',
  'profinet-device': 'PROFINET Device',
  'safety-plc': 'Safety PLC',
  'dcs-controller': 'DCS Ctrl',
  'legacy-plc': 'S7 PLC', // Phase 10
  'iec104-rtu': 'IEC 104', // Phase 10
  'process-unit': 'Process Unit', // Phase 11
  sensor: 'Sensor',
  'iiot-sensor': 'IIoT Sensor',
  'iot-gateway': 'IoT GW',
  'smart-sensor': 'Smart Sensor',
  'smart-controller': 'Smart Ctrl',
  // ── Control Center (L3) ─────────────────────────────────────────────────────
  hmi: 'HMI',
  historian: 'Historian',
  'scada-server': 'SCADA Srv',
  'application-server': 'App Server',
  'database-server': 'DB Server',
  'engineering-workstation': 'Eng. WS',
  // ── Plant DMZ (L3.5) ────────────────────────────────────────────────────────
  firewall: 'Firewall',
  'ids-ips': 'IDS/IPS',
  switch: 'Switch',
  router: 'Router',
  'jump-server': 'Jump Server',
  'data-diode': 'Data Diode',
  wap: 'Wireless AP',
  // ── Enterprise (L4) ─────────────────────────────────────────────────────────
  'domain-controller': 'Domain Ctrl',
  'web-server': 'Web Server',
  'business-server': 'Biz Server',
  'enterprise-desktop': 'Desktop',
  // ── Internet DMZ (L5) ───────────────────────────────────────────────────────
  'email-server': 'Email Server',
  'internet-server': 'Internet Srv',
  'dns-server': 'DNS Server', // Phase 12
  'ip-camera': 'IP Camera',
  // ── Red Team ────────────────────────────────────────────────────────────────
  'attack-machine': 'Attack Machine'
}

/**
 * Maps a device category to its default Purdue zone.
 * Used during auto-layout when no visual positions have been saved yet,
 * and when the canvas needs to infer the zone of a newly dropped device.
 */
function categoryToZone(category: DeviceCategory): NetworkZone {
  // Red Team — isolated subnet, not shown in any Purdue layer tab
  if (category === 'attack-machine') return 'attacker'
  // Level 4 Enterprise Zone
  if (
    ['domain-controller', 'web-server', 'business-server', 'enterprise-desktop'].includes(category)
  )
    return 'enterprise'
  // Level 5 Internet DMZ
  if (['email-server', 'internet-server', 'dns-server'].includes(category)) return 'internet-dmz'
  // Level 3.5 Plant DMZ — security boundary devices and access control
  if (['firewall', 'ids-ips', 'jump-server', 'data-diode', 'wap'].includes(category))
    return 'plant-dmz'
  // Level 3 Control Center
  if (
    [
      'hmi',
      'historian',
      'scada-server',
      'application-server',
      'database-server',
      'engineering-workstation'
    ].includes(category)
  )
    return 'control'
  // Level 0–2 OT (PLCs, RTUs, sensors, actuators, switches, routers on the field network)
  return 'ot'
}

/**
 * Maps a legacy (pre-smart-controller/smart-sensor-consolidation) DeviceCategory
 * string to its modern { category, kind } equivalent. Scenarios authored before that
 * consolidation (e.g. ICS_Lab_01.otflab) can have visual-only nodes (see
 * resolveVisualOnlyDevice() below) whose saved `cn.type` is one of these 9 removed
 * categories -- without this migration, ICON_MAP[cn.type] is undefined and DeviceIcon's
 * render throws, crashing the whole app (confirmed: this is exactly what broke
 * ICS_Lab_01 after that consolidation -- inlet-pump-1/outlet-valve-1 are intentionally
 * container-less decorative nodes with `type: 'pump'`/`'valve'`).
 */
const LEGACY_CATEGORY_MIGRATION: Partial<
  Record<
    string,
    {
      category: DeviceCategory
      controllerKind?: ControllerConfig['kind']
      sensorKind?: SensorConfig['kind']
    }
  >
> = {
  pump: { category: 'smart-controller', controllerKind: 'pump' },
  valve: { category: 'smart-controller', controllerKind: 'valve' },
  vfd: { category: 'smart-controller', controllerKind: 'vfd' },
  actuator: { category: 'smart-controller', controllerKind: 'actuator' },
  'flow-meter': { category: 'smart-sensor', sensorKind: 'flow' },
  'pressure-transmitter': { category: 'smart-sensor', sensorKind: 'pressure' },
  'level-transmitter': { category: 'smart-sensor', sensorKind: 'level' },
  analyzer: { category: 'smart-sensor', sensorKind: 'analyzer' },
  pmu: { category: 'smart-sensor', sensorKind: 'pmu' }
}

/**
 * Builds the fallback DeviceConfig for a visual-only node (one with a CanvasNode entry
 * but no devices.devices entry -- by design, for decorative nodes with no container,
 * e.g. ICS_Lab_01's inlet-pump-1/outlet-valve-1/level-sensor-1). Migrates legacy
 * pre-consolidation type strings via LEGACY_CATEGORY_MIGRATION so the correct icon
 * renders instead of crashing on an unrecognized category.
 */
function resolveVisualOnlyDevice(cn: CanvasNode): DeviceConfig {
  const legacy = LEGACY_CATEGORY_MIGRATION[cn.type]
  const base = {
    nodeId: cn.id,
    ipAddress: '',
    protocols: ['none' as Protocol]
  }
  if (legacy?.controllerKind) {
    return {
      ...base,
      category: legacy.category,
      // Only `kind` is required on ControllerConfig -- no need to borrow
      // DEFAULT_CONTROLLER_CONFIG's pump-specific defaults onto e.g. a valve.
      controller: { kind: legacy.controllerKind }
    }
  }
  if (legacy?.sensorKind) {
    return {
      ...base,
      category: legacy.category,
      sensor: { ...DEFAULT_SENSOR_CONFIG, kind: legacy.sensorKind }
    }
  }
  // Visual-only nodes (pump, valve, sensor) live in visual.nodes but not in
  // devices.devices because they have no container. Use cn.type (the category
  // written at drop time) so the correct icon appears instead of defaulting
  // to 'sensor' for everything. ipAddress '' suppresses the IP label display.
  return { ...base, category: (cn.type as DeviceCategory) ?? ('sensor' as DeviceCategory) }
}

/**
 * Converts a scenario's visual layer into React Flow DeviceNode objects,
 * filtered to the given activeLayer only.
 *
 * Two layout paths:
 *   1. Saved positions (scenario.visual.nodes.length > 0) — restored directly.
 *   2. No saved positions — simple 6-column grid starting at (80, 80); no zone
 *      band y-offsets needed since each tab shows only its own devices.
 */
function scenarioToNodes(scenario: OTForgeScenario, activeLayer: NetworkZone): DeviceNodeType[] {
  const hasVisual = scenario.visual.nodes.length > 0

  if (hasVisual) {
    return scenario.visual.nodes
      .filter(cn => cn.data.zone === activeLayer)
      .map(cn => ({
        id: cn.id,
        type: 'deviceNode' as const,
        position: cn.position,
        // Pre-declare dimensions so React Flow knows node size before DOM measurement.
        // Keeps edges positioned correctly on first render and after layer switches.
        width: CELL_SIZE,
        height: CELL_SIZE,
        data: {
          device: scenario.devices.devices[cn.id] ?? resolveVisualOnlyDevice(cn),
          label: cn.data.label,
          zone: cn.data.zone as NetworkZone
        }
      }))
  }

  // Auto-layout: collect only devices belonging to this layer, then grid them
  const layerDeviceIds = Object.keys(scenario.devices.devices).filter(
    id => categoryToZone(scenario.devices.devices[id].category) === activeLayer
  )

  return layerDeviceIds.map((id, i) => {
    const dev = scenario.devices.devices[id]
    return {
      id,
      type: 'deviceNode' as const,
      // Auto-layout in a 6-column grid aligned to CELL_SIZE boundaries so nodes
      // land precisely on grid lines when a scenario is first loaded.
      position: {
        x: (i % 6) * CELL_SIZE,
        y: Math.floor(i / 6) * CELL_SIZE
      },
      width: CELL_SIZE,
      height: CELL_SIZE,
      data: {
        device: dev,
        label: CATEGORY_LABELS[dev.category],
        zone: activeLayer
      }
    }
  })
}

/**
 * Converts a scenario's visual edge list into typed React Flow edge objects,
 * filtered so only edges where BOTH endpoints are in the current layer are shown.
 *
 * OT layer → PipeEdgeType (orthogonal P&ID routing)
 * All other layers → ProtocolEdgeType (bezier curves)
 */

/**
 * Picks the best source/target handle IDs based on which axis dominates between
 * the two nodes. Handle IDs must match the `id` props on DeviceNode's Handles.
 * This is called both when loading edges from the scenario and when creating new
 * edges via two-click, so every edge is routed to the geometrically nearest side.
 */
export function bestHandles(
  srcPos: { x: number; y: number },
  tgtPos: { x: number; y: number }
): { sourceHandle: string; targetHandle: string } {
  const dx = tgtPos.x - srcPos.x
  const dy = tgtPos.y - srcPos.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceHandle: 's-right', targetHandle: 't-left' }
      : { sourceHandle: 's-left', targetHandle: 't-right' }
  } else {
    return dy >= 0
      ? { sourceHandle: 's-bottom', targetHandle: 't-top' }
      : { sourceHandle: 's-top', targetHandle: 't-bottom' }
  }
}

function scenarioToEdges(
  scenario: OTForgeScenario,
  activeLayer: NetworkZone,
  layerNodeIds: Set<string>
): (ProtocolEdgeType | PipeEdgeType)[] {
  const edgeType = activeLayer === 'ot' ? ('pipeEdge' as const) : ('protocolEdge' as const)
  const nodePositions = new Map(scenario.visual.nodes.map(n => [n.id, n.position]))

  return scenario.visual.edges
    .filter(ce => layerNodeIds.has(ce.source) && layerNodeIds.has(ce.target))
    .map(ce => {
      // Use explicit handles from the scenario JSON when present; fall back to automatic
      // bestHandles() computation. Explicit handles are needed when the auto-computed
      // path would route through intermediate nodes (e.g., a long backward edge that
      // crosses other devices). See CanvasEdge.sourceHandle / targetHandle in schema.
      const auto = bestHandles(
        nodePositions.get(ce.source) ?? { x: 0, y: 0 },
        nodePositions.get(ce.target) ?? { x: 0, y: 0 }
      )
      const sourceHandle = ce.sourceHandle ?? auto.sourceHandle
      const targetHandle = ce.targetHandle ?? auto.targetHandle
      return {
        id: ce.id,
        source: ce.source,
        target: ce.target,
        sourceHandle,
        targetHandle,
        type: edgeType,
        data: {
          protocol: ce.data.protocol,
          ...(ce.data.label !== undefined ? { label: ce.data.label } : {}),
          ...(ce.data.cableType !== undefined ? { cableType: ce.data.cableType } : {}),
          ...(activeLayer === 'ot' && ce.data.fluidType !== undefined
            ? { fluidType: ce.data.fluidType }
            : {}),
          ...(activeLayer === 'ot' && ce.data.coilSource !== undefined
            ? { coilSource: ce.data.coilSource }
            : {})
        }
      }
    })
}

interface ScadaCanvasProps {
  scenario: OTForgeScenario | null
  /** The currently active Purdue layer — scopes which nodes and edges are visible. */
  activeLayer: NetworkZone
  /**
   * Whether to show and snap to the 25 × 25 cell grid.
   * When true, enables visual grid lines (BackgroundVariant.Lines at CELL_SIZE gap)
   * and React Flow's snap-to-grid behavior. Passed as false during simulation so
   * the grid disappears and snap is disabled while containers are running.
   */
  showGrid: boolean
  /**
   * When true, the canvas is view-only: devices cannot be added, moved, connected,
   * or deleted. Used in Student mode (locked scenario) to prevent topology modification.
   * Pan, zoom, and node selection (for PropertiesPanel) still work.
   */
  readOnly?: boolean
  /**
   * Flat list of all pack-contributed device types from installed community packs.
   * When a device is dropped from the pack palette section, the canvas looks up the
   * matching entry here to resolve the custom Docker image and canonical label.
   * Passed down from App so the canvas doesn't need to call the IPC directly.
   */
  packDeviceTypes?: import('@otforge/schema').ResolvedPackDeviceType[]
  /**
   * Whether the simulation is currently running.
   * When true and the OT layer is active, the canvas polls PLC coil states every
   * 2 s and applies flow-state colors and animations to coil-sourced pipe edges.
   */
  simRunning?: boolean
  onSelectDevice: (nodeId: string | null, device: DeviceConfig | null) => void
  onScenarioChange: (updater: (s: OTForgeScenario | null) => OTForgeScenario | null) => void
  /**
   * Called when a PipeEdge is selected on the OT layer in Author Mode.
   * App.tsx uses this to show the EdgePanel in the right sidebar.
   * Receives null when the selection is cleared or a non-pipe element is selected.
   */
  onSelectEdge?: (edgeId: string | null) => void
  /**
   * Called when the user clicks a cross-layer stub badge on a device node.
   * Switches the active Purdue layer tab to the destination zone so the student
   * can follow the connection chain across layers. Optional — stubs are hidden
   * when this callback is not provided.
   */
  onLayerChange?: (zone: NetworkZone) => void
}

/**
 * The main SCADA topology canvas, scoped to the active Purdue layer tab.
 *
 * Renders the React Flow canvas showing only the devices and connections that
 * belong to the active layer. Dropping a device assigns it to activeLayer. The
 * OT tab uses a dark P&ID style; other tabs use the standard dark dot-grid.
 */
export function ScadaCanvas({
  scenario,
  activeLayer,
  showGrid,
  readOnly = false,
  packDeviceTypes = [],
  simRunning = false,
  onSelectDevice,
  onScenarioChange,
  onSelectEdge,
  onLayerChange
}: ScadaCanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  // Tracks the currently selected node ID so we can restore selection after
  // scenario-driven setNodes calls (e.g., when a device's IP or label is edited
  // and the sync effect re-runs). Without this, setNodes clears all selection,
  // which closes the Properties Panel mid-edit.
  const selectedNodeIdRef = useRef<string | null>(null)

  /**
   * Live coil state map — keyed by "${nodeId}:${coilIndex}", value is boolean.
   * Populated by the polling useEffect below when the simulation is running and
   * the OT layer is active. Empty map = simulation not running or no coil edges.
   */
  const [coilStates, setCoilStates] = useState<Map<string, boolean>>(new Map())

  /**
   * Live holding-register map — keyed by PLC nodeId, value is HR0 (tank_level, 0–1000 cm).
   * Populated alongside coilStates in the same polling loop via FC03 Read Holding Registers.
   * Empty map = simulation not running. Used to derive fillLevel for process-unit nodes.
   */
  const [levelStates, setLevelStates] = useState<Map<string, number>>(new Map())

  /** Right-click context menu — null when closed. */
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  /**
   * Pending two-click connection state.
   * After the user picks a protocol from the context menu, this holds the source
   * node ID and chosen protocol until they click a target (or press Escape).
   */
  const [pendingConnection, setPendingConnection] = useState<PendingConnectionState | null>(null)

  /**
   * Tooltip displayed when the student clicks an invalid target during a pending
   * connection. Shows the rejection reason from getRejectionReason() and auto-clears
   * after 3 seconds. Positioned at the cursor's clientX/clientY.
   */
  const [invalidTooltip, setInvalidTooltip] = useState<{
    message: string
    x: number
    y: number
  } | null>(null)

  /**
   * Controls whether the "Add Field Site" dropdown menu is open.
   * Toggled by the button in the canvas toolbar; closed on any option click.
   */
  const [showSiteMenu, setShowSiteMenu] = useState(false)

  /**
   * Ref to the React Flow instance — needed for screenToFlowPosition() in onDrop.
   * Using a ref avoids wrapping in ReactFlowProvider just to call useReactFlow().
   */
  const rfInstance = useRef<ReactFlowInstance | null>(null)

  /**
   * Previous displayNodes array — reuse object refs when decorations are unchanged
   * so cross-layer stub injection / pending-connection classNames don't remount
   * every node and wipe edge paths.
   */
  const prevDisplayNodesRef = useRef<Node[]>([])

  /**
   * Tracks the last layer that triggered a fitView call.
   * fitView must only run when the user switches layer tabs, NOT on every scenario
   * mutation (node added, node dragged, edge added). Without this guard, dropping a
   * device triggers a scenario update which fires the useEffect, which calls fitView,
   * which re-centers the viewport — making the device appear to "snap to center".
   */
  const prevLayerRef = useRef<NetworkZone | null>(null)
  const prevScenarioKeyRef = useRef<string | null>(null)

  /**
   * Timer ref for auto-dismissing the invalid connection tooltip.
   * Stored in a ref so the previous timer can be cancelled before setting a new one
   * (prevents stale closures from clearing a tooltip the user just triggered).
   */
  const tooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * Polls PLC coil states AND holding registers via Modbus TCP while the simulation
   * is running on the OT layer.
   *
   * Every 2 s:
   *   - FC01 Read Coils  → coilStates  → pipe-edge flow animation (green/red)
   *   - FC03 Read Holding Registers → levelStates → process-unit fill animation
   *
   * Groups reads by PLC nodeId so one IPC round-trip covers all coil edges for a PLC.
   * Holding registers always read 3 registers (HR0=tank_level, HR1=inlet_flow,
   * HR2=outlet_flow) from the same PLCs found via coilSource edges.
   *
   * The polling interval clears when the simulation stops, the layer changes, or the
   * component unmounts so there are no dangling timers.
   *
   * All failures are silent (readCoils/readHoldingRegisters return [] on error) so a
   * temporarily unreachable PLC does not break the canvas — last known state persists.
   */
  useEffect(() => {
    if (!simRunning || activeLayer !== 'ot') {
      setCoilStates(new Map())
      setLevelStates(new Map())
      return
    }

    // Collect edges that carry a coilSource binding (the wired OT pipe edges)
    const coilEdges = edges.filter(e => {
      const d = e.data as unknown as import('./PipeEdge').PipeEdgeData
      return d?.coilSource !== undefined
    })
    if (coilEdges.length === 0) return

    // Group by PLC nodeId, tracking the highest coilIndex needed for each PLC so
    // a single FC01 frame reads all coils in one round-trip.
    const plcMaxCoil = new Map<string, number>()
    for (const edge of coilEdges) {
      const { nodeId, coilIndex } = (edge.data as unknown as import('./PipeEdge').PipeEdgeData)
        .coilSource!
      const current = plcMaxCoil.get(nodeId) ?? -1
      if (coilIndex > current) plcMaxCoil.set(nodeId, coilIndex)
    }

    const poll = async () => {
      const nextCoils = new Map<string, boolean>()
      const nextLevels = new Map<string, number>()

      for (const [nodeId, maxIdx] of plcMaxCoil.entries()) {
        // ── FC01 Read Coils — drives pipe-edge flow animation ──────────────────
        try {
          const coils = await window.electronAPI.modbus.readCoils(nodeId, maxIdx + 1)
          for (let i = 0; i <= maxIdx; i++) {
            if (coils[i] !== undefined) nextCoils.set(`${nodeId}:${i}`, coils[i])
          }
        } catch {
          // Non-fatal: keep previous coil state for this PLC
        }

        // ── FC03 Read Holding Registers — drives Water Tank fill animation ─────
        // Read 3 registers: HR0=tank_level (0–1000 cm), HR1=inlet_flow, HR2=outlet_flow
        try {
          const regs = await window.electronAPI.modbus.readHoldingRegisters(nodeId, 3)
          if (regs.length > 0) nextLevels.set(nodeId, regs[0]) // HR0 = tank_level
        } catch {
          // Non-fatal: keep previous level state for this PLC
        }
      }

      setCoilStates(nextCoils)
      setLevelStates(nextLevels)
    }

    poll() // Immediate first poll — don't wait 2 s for initial values
    const timer = setInterval(poll, 2000)
    return () => clearInterval(timer)
  }, [simRunning, activeLayer, edges])

  /**
   * Edges augmented with live `flowActive` values for coil-sourced pipe edges.
   * Derived from `edges` (React Flow state) and `coilStates` (polling result).
   * Only pipe edges with a `coilSource` binding are modified; all others pass through.
   * Passed to ReactFlow's `edges` prop while the underlying state stays clean for
   * position/type mutations.
   */
  const displayEdges = useMemo(() => {
    if (coilStates.size === 0) return edges
    return edges.map(edge => {
      const pipeData = edge.data as unknown as import('./PipeEdge').PipeEdgeData
      if (!pipeData?.coilSource) return edge
      const key = `${pipeData.coilSource.nodeId}:${pipeData.coilSource.coilIndex}`
      const flowActive = coilStates.get(key)
      if (flowActive === undefined) return edge
      return { ...edge, data: { ...pipeData, flowActive } }
    })
  }, [edges, coilStates])

  /**
   * Context-menu protocol options filtered to only those valid for the source device.
   * When the student right-clicks a Sensor, for example, they see only Modbus and DNP3
   * instead of the full list — this prevents picking a protocol that would then be
   * immediately rejected when they click the target.
   *
   * Falls back to the full CONNECTION_OPTIONS list when the source node cannot be
   * resolved (defensive case — should not occur in normal usage).
   */
  const filteredConnectionOptions = useMemo(() => {
    if (!contextMenu) return CONNECTION_OPTIONS
    const sourceNode = nodes.find(n => n.id === contextMenu.nodeId)
    if (!sourceNode) return CONNECTION_OPTIONS
    const sourceCategory = (sourceNode.data as DeviceNodeData).device.category
    const validProtocols = getSourceProtocols(sourceCategory)
    return CONNECTION_OPTIONS.filter(opt => validProtocols.has(opt.protocol))
  }, [contextMenu, nodes])

  /**
   * Context-menu cable options filtered to those the source device can physically terminate.
   * Sensors only show RS-485/Cat5e/DC; servers show Cat6/Cat6a/Fiber, etc.
   * Cable selection is optional — the user may click a protocol without picking a cable.
   */
  const filteredCableOptions = useMemo(() => {
    if (!contextMenu) return CABLE_OPTIONS
    const sourceNode = nodes.find(n => n.id === contextMenu.nodeId)
    if (!sourceNode) return CABLE_OPTIONS
    const sourceCategory = (sourceNode.data as DeviceNodeData).device.category
    const validCables = getSourceCables(sourceCategory)
    return CABLE_OPTIONS.filter(opt => validCables.has(opt.cable))
  }, [contextMenu, nodes])

  /**
   * Nodes augmented with two kinds of live data, merged into a single memoised array:
   *
   * 1. Connection-state CSS classes (when a pending connection is active):
   *    'connection-source' — the node that was right-clicked to start the connection;
   *                          gets a teal glow so the student knows which device is FROM.
   *    'invalid-target'    — nodes that cannot receive the selected protocol;
   *                          dimmed to 30% opacity, cursor changes to not-allowed.
   *    React Flow applies node.className to its wrapper div, so CSS selectors like
   *    `.invalid-target .device-node { ... }` work correctly.
   *
   * 2. fillLevel for process-unit (Water Tank) nodes — a 0.0–1.0 fraction derived
   *    from HR0 (tank_level, 0–1000 cm) polled from the PLC every 2 s. DeviceNode
   *    uses this to render a rising water fill animation that makes the overflow attack
   *    visible to students without needing a separate Grafana dashboard.
   *
   * The underlying `nodes` state is never mutated — changes live only in displayNodes.
   */
  const displayNodes = useMemo(() => {
    // Step 1 — apply connection-state class names when a pending connection is active
    let result: typeof nodes = nodes

    if (pendingConnection) {
      const sourceNode = nodes.find(n => n.id === pendingConnection.sourceId)
      if (sourceNode) {
        const sourceCategory = (sourceNode.data as DeviceNodeData).device.category
        result = nodes.map(n => {
          // Site region nodes are not connection participants — leave them unstyled.
          if (n.type === 'siteNode') return n
          if (n.id === pendingConnection.sourceId) {
            return { ...n, className: 'connection-source' }
          }
          const targetCategory = (n.data as DeviceNodeData).device.category
          const valid = isConnectionValid(
            sourceCategory,
            targetCategory,
            pendingConnection.protocol
          )
          return { ...n, className: valid ? '' : 'invalid-target' }
        })
      }
    }

    // Step 2 — inject fillLevel into process-unit nodes from live HR0 register polling.
    // Only runs while the simulation is active (levelStates is empty map otherwise).
    if (levelStates.size > 0) {
      result = result.map(n => {
        if (n.type === 'siteNode') return n
        const data = n.data as DeviceNodeData
        if (data.device.category !== 'process-unit') return n

        // Find any connected edge that carries a coilSource to identify which PLC
        // owns the tank_level register. The coilSource.nodeId is the PLC node.
        const connectedEdge = edges.find(e => {
          const d = e.data as unknown as import('./PipeEdge').PipeEdgeData
          return d?.coilSource !== undefined && (e.source === n.id || e.target === n.id)
        })
        if (!connectedEdge) return n

        const { nodeId: plcId } = (
          connectedEdge.data as unknown as import('./PipeEdge').PipeEdgeData
        ).coilSource!
        const raw = levelStates.get(plcId)
        if (raw === undefined) return n

        // Scale tank_level (0–1000 cm) → fillLevel (0.0–1.0), clamped for safety
        const fillLevel = Math.min(1, Math.max(0, raw / 1000))
        return { ...n, data: { ...data, fillLevel } }
      })
    }

    // Step 3 — inject cross-layer links so device nodes can render zone-navigation stubs.
    // Scan ALL scenario edges (not just the current-layer subset) for edges where one
    // endpoint is in the current layer and the other is in a different zone.
    if (scenario && onLayerChange) {
      // Build nodeId → zone lookup from scenario.visual.nodes (all zones)
      const nodeZoneMap = new Map<string, NetworkZone>()
      for (const cn of scenario.visual.nodes) {
        nodeZoneMap.set(cn.id, cn.data.zone as NetworkZone)
      }

      // Accumulate destination zones for each current-layer node
      const crossLayerMap = new Map<string, Set<NetworkZone>>()
      for (const edge of scenario.visual.edges) {
        const sourceZone = nodeZoneMap.get(edge.source)
        const targetZone = nodeZoneMap.get(edge.target)
        if (!sourceZone || !targetZone || sourceZone === targetZone) continue

        // Mark the endpoint that lives in the current layer with the foreign zone
        if (sourceZone === activeLayer) {
          if (!crossLayerMap.has(edge.source)) crossLayerMap.set(edge.source, new Set())
          crossLayerMap.get(edge.source)!.add(targetZone)
        }
        if (targetZone === activeLayer) {
          if (!crossLayerMap.has(edge.target)) crossLayerMap.set(edge.target, new Set())
          crossLayerMap.get(edge.target)!.add(sourceZone)
        }
      }

      if (crossLayerMap.size > 0) {
        result = result.map(n => {
          const foreignZones = crossLayerMap.get(n.id)
          if (!foreignZones || foreignZones.size === 0) return n
          const nodeData = n.data as DeviceNodeData
          const crossLayerLinks: CrossLayerLink[] = Array.from(foreignZones).map(zone => ({
            zone,
            label: ZONE_ABBREVS[zone],
            color: ZONE_COLORS[zone]
          }))
          // Pass onLayerChange through node data so DeviceNode can call it on click.
          // Using a stable reference from props avoids re-creating the entire node array
          // every render — callers (App.tsx) should provide a stable setActiveLayer ref.
          return { ...n, data: { ...nodeData, crossLayerLinks, onLayerNavigate: onLayerChange } }
        })
      }
    }

    // Keep RF node object identity stable across decoration rebuilds (pending
    // connection highlight, cross-layer stubs, tank fill). New object refs here
    // are the same class of bug as setNodes(allNodes) — traces vanish until tab switch.
    const prevById = new Map(prevDisplayNodesRef.current.map(n => [n.id, n]))
    const reconciled = result.map(fresh => {
      const prev = prevById.get(fresh.id)
      return prev && displayNodeEqual(prev, fresh) ? prev : fresh
    })
    prevDisplayNodesRef.current = reconciled
    return reconciled
  }, [nodes, pendingConnection, levelStates, edges, scenario, activeLayer, onLayerChange])

  // Sync canvas state when the scenario or active layer changes
  useEffect(() => {
    if (!scenario) {
      setNodes([])
      setEdges([])
      prevDisplayNodesRef.current = []
      // No nodes — show the full 25 × 25 canvas area so the user sees the grid
      setTimeout(() => {
        if (rfInstance.current) fitCanvasView(rfInstance.current)
      }, 100)
      prevLayerRef.current = null
      prevScenarioKeyRef.current = null
      return
    }
    const deviceNodes = scenarioToNodes(scenario, activeLayer)
    const layerNodeIds = new Set(deviceNodes.map(n => n.id))

    // Build site region nodes for this layer. Site nodes render behind device nodes
    // so they serve as visual grouping regions without obscuring device icons.
    // They are placed first in the array (lower z-order) and given zIndex: -1.
    const siteNodes: SiteNodeType[] = (scenario.visual.siteRegions ?? [])
      .filter(r => r.zone === activeLayer)
      .map(r => ({
        id: r.id,
        type: 'siteNode' as const,
        position: r.position,
        width: r.width,
        height: r.height,
        // zIndex -1 ensures site regions always render beneath device nodes.
        zIndex: -1,
        // Sites are selectable (to show resize handles) but not connectable.
        selectable: !readOnly,
        draggable: !readOnly,
        data: {
          region: r,
          readOnly,
          onLabelChange: handleSiteLabelChange,
          onColorChange: handleSiteColorChange,
          onResizeEnd: handleSiteResizeEnd
        } satisfies SiteNodeData
      }))

    // Restore the previously selected node so that scenario-driven re-syncs
    // (e.g., IP or label edits) don't close the Properties Panel.
    const selId = selectedNodeIdRef.current
    const allNodes: Node[] = [
      ...siteNodes,
      ...(selId
        ? deviceNodes.map(n => (n.id === selId ? { ...n, selected: true } : n))
        : deviceNodes)
    ]
    // Reuse existing node object refs by id. A full remount leaves RF edge paths
    // on stale handle bounds (traces vanish until a layer-tab switch).
    setNodes(prev => {
      const prevById = new Map(prev.map(n => [n.id, n]))
      return allNodes.map(fresh => {
        const existing = prevById.get(fresh.id)
        if (!existing) return fresh
        // fresh.data is always a new object from scenarioToNodes — compare fields.
        const samePos =
          existing.position.x === fresh.position.x && existing.position.y === fresh.position.y
        const sameSel = !!existing.selected === !!fresh.selected
        if (samePos && sameSel && nodeRenderEqual(existing, fresh)) return existing
        return {
          ...existing,
          position: fresh.position,
          data: fresh.data,
          selected: fresh.selected,
          width: fresh.width ?? existing.width,
          height: fresh.height ?? existing.height,
          zIndex: fresh.zIndex,
          selectable: fresh.selectable,
          draggable: fresh.draggable
        }
      })
    })
    // Mark every edge as reconnectable so the user can drag endpoints to reroute
    // connections without having to delete and recreate them (read-only mode excluded).
    setEdges(
      (scenarioToEdges(scenario, activeLayer, layerNodeIds) as Edge[]).map(e => ({
        ...e,
        reconnectable: !readOnly
      }))
    )
    // Only re-fit when the active layer tab changes — not on every node/edge mutation.
    // Scenario edits (drops, drags, connections) must not re-center the viewport.
    const scenarioKey = `${scenario.meta.name}\0${scenario.meta.createdAt}`
    if (scenarioKey !== prevScenarioKeyRef.current) {
      prevScenarioKeyRef.current = scenarioKey
      prevLayerRef.current = null
    }
    if (prevLayerRef.current !== activeLayer) {
      prevLayerRef.current = activeLayer
      setTimeout(() => {
        if (rfInstance.current) fitCanvasView(rfInstance.current)
      }, 50)
    }
    // Only re-sync when visual layout or device graph changes — security updates
    // (firewallRules, IDS config) share the same scenario object but don't affect
    // canvas nodes, and triggering setNodes on every security edit clears the
    // React Flow selection, kicking the user out of the firewall panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario?.visual, scenario?.devices, activeLayer, setNodes, setEdges])

  /*
   * Re-fit whenever the browser window is resized or maximized.
   * Without this the canvas stays zoomed to the window size at mount time
   * even after the user resizes to a larger viewport.
   */
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const handleResize = () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (rfInstance.current) fitCanvasView(rfInstance.current)
      }, 150)
    }
    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      clearTimeout(timer)
    }
  }, [])

  /**
   * New protocol edge — OT tab creates a pipeEdge, all others a protocolEdge.
   * Default protocol is modbus-tcp; user can change via edge properties.
   */
  const onConnect: OnConnect = useCallback(
    connection => {
      const edgeType = activeLayer === 'ot' ? 'pipeEdge' : 'protocolEdge'
      const newEdge = {
        ...connection,
        id: `${connection.source}-${connection.target}-${Date.now()}`,
        type: edgeType,
        data: { protocol: 'modbus-tcp' as Protocol }
      }
      setEdges(eds => addEdge(newEdge as Edge, eds))

      if (connection.source && connection.target) {
        onScenarioChange(prev => {
          if (!prev) return prev
          const ce = {
            id: newEdge.id,
            source: connection.source!,
            target: connection.target!,
            data: { protocol: 'modbus-tcp' as Protocol }
          }
          return { ...prev, visual: { ...prev.visual, edges: [...prev.visual.edges, ce] } }
        })
      }
    },
    [setEdges, onScenarioChange, activeLayer]
  )

  /** Handles selection changes — device nodes populate PropertiesPanel; pipe edges populate EdgePanel. */
  const onSelectionChange = useCallback(
    ({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams) => {
      // Single device node selected → show device properties
      if (selectedNodes.length === 1 && selectedNodes[0].type === 'deviceNode') {
        const node = selectedNodes[0]
        selectedNodeIdRef.current = node.id
        const data = node.data as DeviceNodeData
        onSelectDevice(node.id, data.device)
        onSelectEdge?.(null)
        return
      }

      // Single pipe edge selected on OT layer in Author Mode → show edge properties
      if (
        selectedNodes.length === 0 &&
        selectedEdges.length === 1 &&
        activeLayer === 'ot' &&
        !readOnly
      ) {
        selectedNodeIdRef.current = null
        onSelectDevice(null, null)
        onSelectEdge?.(selectedEdges[0].id)
        return
      }

      // Anything else — clear both panels
      selectedNodeIdRef.current = null
      onSelectDevice(null, null)
      onSelectEdge?.(null)
    },
    [onSelectDevice, onSelectEdge, activeLayer, readOnly]
  )

  const onDragOver = useCallback(
    (event: React.DragEvent) => {
      if (readOnly) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    [readOnly]
  )

  /**
   * Node deletion — called by React Flow after it removes nodes from canvas state.
   * Persists the removal to scenario.visual.nodes, scenario.visual.edges (prune
   * any edges that referenced a deleted node), and scenario.devices.devices.
   * Also clears the PropertiesPanel selection so it doesn't show a stale device.
   */
  const onNodesDelete = useCallback(
    (deletedNodes: Node[]) => {
      const deletedIds = new Set(deletedNodes.map(n => n.id))
      onSelectDevice(null, null)
      onSelectEdge?.(null)
      onScenarioChange(prev => {
        if (!prev) return prev
        return {
          ...prev,
          visual: {
            ...prev.visual,
            nodes: prev.visual.nodes.filter(n => !deletedIds.has(n.id)),
            edges: prev.visual.edges.filter(
              e => !deletedIds.has(e.source) && !deletedIds.has(e.target)
            ),
            // Also remove any site regions that were deleted.
            siteRegions: (prev.visual.siteRegions ?? []).filter(r => !deletedIds.has(r.id))
          },
          devices: {
            devices: Object.fromEntries(
              Object.entries(prev.devices.devices).filter(([id]) => !deletedIds.has(id))
            )
          }
        }
      })
    },
    [onScenarioChange, onSelectDevice]
  )

  /** Updates a site region's label in the scenario when the author commits an edit. */
  const handleSiteLabelChange = useCallback(
    (siteId: string, label: string) => {
      onScenarioChange(prev => {
        if (!prev) return prev
        return {
          ...prev,
          visual: {
            ...prev.visual,
            siteRegions: (prev.visual.siteRegions ?? []).map(r =>
              r.id === siteId ? { ...r, label } : r
            )
          }
        }
      })
    },
    [onScenarioChange]
  )

  /** Updates a site region's color in the scenario when the author picks a new color. */
  const handleSiteColorChange = useCallback(
    (siteId: string, color: string) => {
      onScenarioChange(prev => {
        if (!prev) return prev
        return {
          ...prev,
          visual: {
            ...prev.visual,
            siteRegions: (prev.visual.siteRegions ?? []).map(r =>
              r.id === siteId ? { ...r, color } : r
            )
          }
        }
      })
    },
    [onScenarioChange]
  )

  /** Persists updated position + dimensions after a NodeResizer drag ends. */
  const handleSiteResizeEnd = useCallback(
    (siteId: string, x: number, y: number, width: number, height: number) => {
      onScenarioChange(prev => {
        if (!prev) return prev
        return {
          ...prev,
          visual: {
            ...prev.visual,
            siteRegions: (prev.visual.siteRegions ?? []).map(r =>
              r.id === siteId ? { ...r, position: { x, y }, width, height } : r
            )
          }
        }
      })
    },
    [onScenarioChange]
  )

  /**
   * Creates a new site region of the given type and adds it to the center of the
   * current viewport. Local sites default to teal; remote sites to amber.
   */
  const handleAddSite = useCallback(
    (type: 'local' | 'remote') => {
      setShowSiteMenu(false)
      if (!rfInstance.current) return

      // Count existing sites of this type to generate an auto-incremented label.
      onScenarioChange(prev => {
        if (!prev) return prev
        const existing = prev.visual.siteRegions ?? []
        const sameType = existing.filter(r =>
          type === 'local'
            ? r.label.toLowerCase().includes('local')
            : r.label.toLowerCase().includes('remote')
        )
        const index = sameType.length
        const label = type === 'local' ? `Local Site ${index}` : `Remote Site ${index + 1}`
        const color = type === 'local' ? '#22c55e' : '#f59e0b'

        // Use screenToFlowPosition on the visible center of the canvas element.
        const rect = (
          document.querySelector('.react-flow') as HTMLElement | null
        )?.getBoundingClientRect()
        const centerX = rect ? rect.left + rect.width / 2 : 0
        const centerY = rect ? rect.top + rect.height / 2 : 0
        const pos = rfInstance.current!.screenToFlowPosition({ x: centerX, y: centerY })

        const newRegion: SiteRegion = {
          id: `site-${type}-${Date.now()}`,
          label,
          color,
          zone: activeLayer,
          position: { x: pos.x - 160, y: pos.y - 110 },
          width: 320,
          height: 220
        }

        return {
          ...prev,
          visual: {
            ...prev.visual,
            siteRegions: [...existing, newRegion]
          }
        }
      })
    },
    [onScenarioChange, activeLayer]
  )

  /**
   * Edge deletion — called by React Flow after it removes edges from canvas state.
   * Persists the removal to scenario.visual.edges.
   */
  const onEdgesDelete = useCallback(
    (deletedEdges: Edge[]) => {
      const deletedIds = new Set(deletedEdges.map(e => e.id))
      onScenarioChange(prev => {
        if (!prev) return prev
        return {
          ...prev,
          visual: {
            ...prev.visual,
            edges: prev.visual.edges.filter(e => !deletedIds.has(e.id))
          }
        }
      })
    },
    [onScenarioChange]
  )

  /**
   * Cancels any open context menu, in-progress pending connection, or invalid tooltip.
   * Bound to clicking empty canvas space, pressing Escape, and the Cancel menu item.
   */
  const cancelConnection = useCallback(() => {
    setContextMenu(null)
    setPendingConnection(null)
    setInvalidTooltip(null)
    setShowSiteMenu(false)
    if (tooltipTimerRef.current !== null) {
      clearTimeout(tooltipTimerRef.current)
      tooltipTimerRef.current = null
    }
  }, [])

  /**
   * Right-click on a canvas device node — opens the protocol selection menu at the
   * cursor position and cancels any previously pending connection.
   * Disabled in readOnly mode (Student mode) — no new edges can be created.
   */
  const onNodeContextMenu = useCallback(
    (event: React.MouseEvent, node: Node) => {
      if (readOnly) return
      // Site region nodes have no device protocols — suppress the context menu.
      if (node.type === 'siteNode') return
      event.preventDefault()
      setPendingConnection(null)
      setContextMenu({ nodeId: node.id, x: event.clientX, y: event.clientY })
    },
    [readOnly]
  )

  /**
   * Called when the user picks a protocol from the right-click context menu.
   * Transitions from "menu open" to "awaiting target click" mode, carrying the
   * optional pre-selected cable type and fluid type into the pending connection state.
   * The canvas cursor changes to a crosshair (via .connecting CSS class) to
   * signal that the next node click will complete the connection.
   */
  const startConnection = useCallback(
    (protocol: Protocol) => {
      if (!contextMenu) return
      setPendingConnection({
        sourceId: contextMenu.nodeId,
        protocol,
        cableType: contextMenu.pendingCable,
        fluidType: contextMenu.pendingFluid
      })
      setContextMenu(null)
    },
    [contextMenu]
  )

  /**
   * Toggles the pre-selected cable type in the open context menu.
   * Clicking an already-selected cable deselects it (undefined = no cable).
   * The menu stays open so the user can select a cable AND THEN click a protocol.
   */
  const selectCable = useCallback((cable: CableType) => {
    setContextMenu(prev =>
      prev ? { ...prev, pendingCable: prev.pendingCable === cable ? undefined : cable } : null
    )
  }, [])

  /**
   * Toggles the pre-selected fluid type in the open OT-layer context menu.
   * Clicking an already-selected fluid deselects it (undefined = no fluid icon).
   * The menu stays open so the user can select a fluid AND THEN click a protocol.
   */
  const selectFluid = useCallback((fluid: FluidType) => {
    setContextMenu(prev =>
      prev ? { ...prev, pendingFluid: prev.pendingFluid === fluid ? undefined : fluid } : null
    )
  }, [])

  /** Switch the context menu into its freehand sub-view. */
  const enterFreehandMode = useCallback(() => {
    setContextMenu(prev => (prev ? { ...prev, freehandMode: true, pendingLabel: '' } : null))
  }, [])

  /** Return from the freehand sub-view back to the normal protocol list. */
  const exitFreehandMode = useCallback(() => {
    setContextMenu(prev =>
      prev ? { ...prev, freehandMode: false, pendingLabel: undefined } : null
    )
  }, [])

  /** Update the custom label text the user is typing in freehand sub-view. */
  const updateFreehandLabel = useCallback((label: string) => {
    setContextMenu(prev => (prev ? { ...prev, pendingLabel: label } : null))
  }, [])

  /**
   * Starts a freehand (validation-free) pending connection.
   * Uses whatever fluid type is pre-selected in the menu plus the typed label.
   * Protocol is always 'none' so the edge renders at the unvalidated style width.
   */
  const startFreehandConnection = useCallback(() => {
    if (!contextMenu) return
    setPendingConnection({
      sourceId: contextMenu.nodeId,
      protocol: 'none' as Protocol,
      fluidType: contextMenu.pendingFluid,
      freehand: true,
      freeLabel: contextMenu.pendingLabel || undefined
    })
    setContextMenu(null)
  }, [contextMenu])

  /**
   * Click on a canvas device node.
   *
   * If a pending connection is active:
   *   1. Self-click → cancel the connection (no self-loops).
   *   2. Valid target → create the edge and persist it to the scenario.
   *   3. Invalid target → show a rejection tooltip at the cursor position with an
   *      educational explanation. The connection is NOT created and the pending state
   *      stays active so the student can click a valid target instead.
   *
   * Validation uses the VALID_CONNECTIONS matrix from connectionRules.ts, which
   * encodes the ICS Purdue Reference Model (IEC 62443-3-2 / NIST SP 800-82).
   *
   * If no pending connection is active this is a no-op — selection is handled by
   * onSelectionChange via React Flow's built-in machinery.
   */
  const onNodeClick = useCallback(
    (event: React.MouseEvent, node: Node) => {
      if (!pendingConnection) return

      if (node.id === pendingConnection.sourceId) {
        // Clicked the source again — treat as cancel
        cancelConnection()
        return
      }

      // Site region nodes are not valid connection targets — ignore clicks on them
      // while a pending connection is active so the connection stays live.
      if (node.type === 'siteNode') return

      // ── Freehand mode — bypass all validation ─────────────────────────────
      // When the user chose "Draw Freehand Connection" from the right-click menu
      // all Purdue-model and cable checks are skipped. The edge is created with
      // whatever fluid type and custom label the user specified.
      if (pendingConnection.freehand) {
        const edgeType = activeLayer === 'ot' ? 'pipeEdge' : 'protocolEdge'
        const fhData: { protocol: Protocol; fluidType?: FluidType; label?: string } = {
          protocol: pendingConnection.protocol,
          ...(pendingConnection.fluidType ? { fluidType: pendingConnection.fluidType } : {}),
          ...(pendingConnection.freeLabel ? { label: pendingConnection.freeLabel } : {})
        }
        const srcNodeFh = nodes.find(n => n.id === pendingConnection.sourceId)
        const { sourceHandle: fhSrcHandle, targetHandle: fhTgtHandle } = bestHandles(
          srcNodeFh?.position ?? { x: 0, y: 0 },
          node.position
        )
        const fhEdge: Edge = {
          id: `freehand-${pendingConnection.sourceId}-${node.id}-${Date.now()}`,
          source: pendingConnection.sourceId,
          target: node.id,
          sourceHandle: fhSrcHandle,
          targetHandle: fhTgtHandle,
          type: edgeType,
          reconnectable: true,
          data: fhData
        }
        setEdges(eds => addEdge(fhEdge, eds))
        onScenarioChange(prev => {
          if (!prev) return prev
          const ce = {
            id: fhEdge.id,
            source: pendingConnection.sourceId,
            target: node.id,
            data: fhData
          }
          return { ...prev, visual: { ...prev.visual, edges: [...prev.visual.edges, ce] } }
        })
        setPendingConnection(null)
        return
      }

      // ── Protocol / Purdue-model validation ────────────────────────────────
      // Look up both ends of the attempted connection and check the matrix.
      const sourceNode = nodes.find(n => n.id === pendingConnection.sourceId)
      if (sourceNode) {
        const sourceCategory = (sourceNode.data as DeviceNodeData).device.category
        const targetCategory = (node.data as DeviceNodeData).device.category

        if (!isConnectionValid(sourceCategory, targetCategory, pendingConnection.protocol)) {
          const message = getRejectionReason(
            sourceCategory,
            targetCategory,
            pendingConnection.protocol
          )
          if (tooltipTimerRef.current !== null) clearTimeout(tooltipTimerRef.current)
          setInvalidTooltip({ message, x: event.clientX, y: event.clientY })
          tooltipTimerRef.current = setTimeout(() => setInvalidTooltip(null), 3000)
          return
        }

        // ── Cable type validation (only when a cable was pre-selected) ──────
        if (
          pendingConnection.cableType !== undefined &&
          !isCableValid(sourceCategory, targetCategory, pendingConnection.cableType)
        ) {
          const message = getCableRejectionReason(
            sourceCategory,
            targetCategory,
            pendingConnection.cableType
          )
          if (tooltipTimerRef.current !== null) clearTimeout(tooltipTimerRef.current)
          setInvalidTooltip({ message, x: event.clientX, y: event.clientY })
          tooltipTimerRef.current = setTimeout(() => setInvalidTooltip(null), 3000)
          return
        }

        // ── Protocol-cable medium compatibility check ───────────────────────
        // Blocks mismatches like Modbus TCP over RS-485 or EtherNet/IP over Wi-Fi.
        if (
          pendingConnection.cableType !== undefined &&
          !isProtocolCableCompatible(pendingConnection.protocol, pendingConnection.cableType)
        ) {
          const message = getCableRejectionReason(
            sourceCategory,
            targetCategory,
            pendingConnection.cableType,
            pendingConnection.protocol
          )
          if (tooltipTimerRef.current !== null) clearTimeout(tooltipTimerRef.current)
          setInvalidTooltip({ message, x: event.clientX, y: event.clientY })
          tooltipTimerRef.current = setTimeout(() => setInvalidTooltip(null), 3000)
          return
        }
      }

      // ── Valid connection — create the edge ────────────────────────────────
      const edgeType = activeLayer === 'ot' ? 'pipeEdge' : 'protocolEdge'
      const edgeData: { protocol: Protocol; cableType?: CableType; fluidType?: FluidType } = {
        protocol: pendingConnection.protocol,
        ...(pendingConnection.cableType ? { cableType: pendingConnection.cableType } : {}),
        ...(pendingConnection.fluidType ? { fluidType: pendingConnection.fluidType } : {})
      }
      const srcNode = nodes.find(n => n.id === pendingConnection.sourceId)
      const { sourceHandle, targetHandle } = bestHandles(
        srcNode?.position ?? { x: 0, y: 0 },
        node.position
      )
      const newEdge: Edge = {
        id: `${pendingConnection.sourceId}-${node.id}-${Date.now()}`,
        source: pendingConnection.sourceId,
        target: node.id,
        sourceHandle,
        targetHandle,
        type: edgeType,
        data: edgeData
      }

      setEdges(eds => addEdge(newEdge, eds))

      onScenarioChange(prev => {
        if (!prev) return prev
        const ce = {
          id: newEdge.id,
          source: pendingConnection.sourceId,
          target: node.id,
          data: edgeData
        }
        return { ...prev, visual: { ...prev.visual, edges: [...prev.visual.edges, ce] } }
      })

      setPendingConnection(null)
    },
    [pendingConnection, nodes, activeLayer, setEdges, onScenarioChange, cancelConnection]
  )

  /**
   * Edge click handler — toggles a coil-bound pipe edge when simulation is running.
   *
   * Clicking a PipeEdge with a coilSource on the OT layer sends an FC05 Write Single
   * Coil request to the PLC. FC05 writes through the OpenPLC glue pointer directly to
   * the IEC variable, so the program responds in its next 500 ms scan cycle. The coil
   * state is optimistically flipped in coilStates immediately so the pipe color updates
   * without waiting for the next polling interval.
   *
   * No-op when:
   *   - The simulation is not running (no PLC port registered)
   *   - The layer is not OT (no coilSource edges on other layers)
   *   - The edge has no coilSource binding (topology or infrastructure edges)
   */
  const onEdgeClick = useCallback(
    async (_event: React.MouseEvent, edge: Edge) => {
      if (!simRunning || activeLayer !== 'ot') return
      const pipeData = edge.data as unknown as import('./PipeEdge').PipeEdgeData
      if (!pipeData?.coilSource) return

      const { nodeId, coilIndex } = pipeData.coilSource
      const stateKey = `${nodeId}:${coilIndex}`
      // Current coil state — default to true (both coils start ON in the init block)
      const currentValue = coilStates.get(stateKey) ?? true
      const nextValue = !currentValue

      // Optimistic update — flips the pipe color immediately before the poll confirms
      setCoilStates(prev => {
        const next = new Map(prev)
        next.set(stateKey, nextValue)
        return next
      })

      const result = await window.electronAPI.modbus.writeCoil(nodeId, coilIndex, nextValue)
      if (!result.ok) {
        // Write failed — revert the optimistic update so the display stays accurate
        setCoilStates(prev => {
          const next = new Map(prev)
          next.set(stateKey, currentValue)
          return next
        })
      }
    },
    [simRunning, activeLayer, coilStates]
  )

  /**
   * Edge reconnection handler — fires when the user drags an edge endpoint to a
   * new node. React Flow's `reconnectEdge` helper swaps the source or target in
   * the internal edge list; we mirror that change into the scenario JSON so it
   * persists across saves and layer switches.
   *
   * Handle overrides from the original edge (explicit sourceHandle/targetHandle set
   * during authoring) are cleared so bestHandles() re-routes the edge automatically
   * for the new node positions — the user can always re-pin them via JSON if needed.
   */
  const onReconnect = useCallback(
    (oldEdge: Edge, newConnection: Connection) => {
      // Update the React Flow edges state first (optimistic, purely visual)
      setEdges(eds =>
        reconnectEdge(oldEdge, newConnection, eds).map(e => ({ ...e, reconnectable: true }))
      )
      // Persist the new source/target into the scenario model
      onScenarioChange(prev => {
        if (!prev) return prev
        return {
          ...prev,
          visual: {
            ...prev.visual,
            edges: prev.visual.edges.map(ce =>
              ce.id !== oldEdge.id
                ? ce
                : {
                    ...ce,
                    source: newConnection.source ?? ce.source,
                    target: newConnection.target ?? ce.target,
                    // Clear pinned handles — let bestHandles() auto-route from new positions
                    sourceHandle: undefined,
                    targetHandle: undefined
                  }
            )
          }
        }
      })
    },
    [setEdges, onScenarioChange]
  )

  // Escape key cancels the open menu or pending connection
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null)
        setPendingConnection(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  /**
   * Persist node positions after a drag ends.
   * Updates scenario.visual.nodes with the new positions so they survive
   * tab switches and file saves.
   */
  const onNodeDragStop: OnNodeDrag = useCallback(
    (_event, _node, allNodes) => {
      onScenarioChange(prev => {
        if (!prev) return prev
        // Update device node positions.
        const updatedVisualNodes = prev.visual.nodes.map(cn => {
          const moved = allNodes.find(n => n.id === cn.id)
          return moved ? { ...cn, position: moved.position } : cn
        })
        // Update site region positions (dragged site nodes share the same allNodes array).
        const updatedSiteRegions = (prev.visual.siteRegions ?? []).map(r => {
          const moved = allNodes.find(n => n.id === r.id)
          return moved ? { ...r, position: moved.position } : r
        })
        return {
          ...prev,
          visual: { ...prev.visual, nodes: updatedVisualNodes, siteRegions: updatedSiteRegions }
        }
      })
    },
    [onScenarioChange]
  )

  /**
   * Device drop from palette onto canvas.
   * Zone assignment comes from activeLayer — no y-coordinate lookup needed.
   * No-op in readOnly mode (Student mode).
   *
   * Handles two drop sources:
   *   1. Built-in palette items — only `deviceCategory` drag data is set.
   *   2. Pack palette items — both `deviceCategory` and `packDeviceTypeId` are set.
   *      The `packDeviceTypeId` format is `<packId>:<typeId>`. The canvas resolves
   *      it against `packDeviceTypes` to get the custom Docker image and label.
   */
  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault()
      if (readOnly) return
      const category = event.dataTransfer.getData('deviceCategory') as DeviceCategory
      if (!category || !rfInstance.current) return

      // Check if this is a pack device type drop
      const packDeviceTypeId = event.dataTransfer.getData('packDeviceTypeId') || null
      const packDeviceType = packDeviceTypeId
        ? (packDeviceTypes.find(dt => `${dt.packId}:${dt.id}` === packDeviceTypeId) ?? null)
        : null

      const rawPos = rfInstance.current.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY
      })
      // Snap to the nearest cell boundary on drop.
      // React Flow's snapToGrid prop only activates during drag; the initial drop
      // position must be rounded manually to keep icons on the grid.
      const position = showGrid
        ? {
            x: Math.round(rawPos.x / CELL_SIZE) * CELL_SIZE,
            y: Math.round(rawPos.y / CELL_SIZE) * CELL_SIZE
          }
        : rawPos

      const zone = activeLayer
      const nodeId = `${category}-${Date.now()}`
      // Assign the lowest unused IP in the zone so multiple devices on the same
      // network don't collide — Docker rejects compose files with duplicate IPs.
      const existingDevices = scenario?.devices.devices ?? {}
      const device: DeviceConfig = {
        nodeId,
        category,
        // Attack machine always gets an attacker-zone IP regardless of which Purdue
        // tab it's dropped on (Insider Threat mode — see scenario.security.insiderThreat).
        // attacker-net is the one zone network created without internal: true, so this
        // is what preserves real internet/host routing for Kali. The device's VISUAL
        // zone (below, used for node.data.zone) still tracks the drop location — that's
        // what compose-generator.ts reads to grant real access to that zone too, on top
        // of the default attacker-net + internet-dmz-net legs.
        ipAddress:
          category === 'attack-machine'
            ? nextAvailableIp('attacker', existingDevices)
            : nextAvailableIp(zone, existingDevices),
        // Pack device types supply their own default protocols; built-ins use the map.
        protocols: packDeviceType?.defaultProtocols ?? DEFAULT_PROTOCOLS[category],
        // dockerImage override: pack device types specify the exact image to use.
        // This is read by compose-generator.ts to substitute the default category image.
        ...(packDeviceType?.defaultDockerImage
          ? { dockerImage: packDeviceType.defaultDockerImage }
          : {})
      }

      // IED devices run the DNP3 outstation container — pre-populate default DNP3
      // config so the PropertiesPanel shows the addresses immediately and the compose
      // generator can inject the correct env vars without the user having to configure
      // them first. outstationAddress 10 is a recognisable non-zero default; users can
      // change it in PropertiesPanel. port 20000 is the IANA-registered DNP3 TCP port.
      if (category === 'ied') {
        device.dnp3 = { masterAddress: 1, outstationAddress: 10, port: 20000 }
      }

      // RTU devices get a sensible default deployment config so the RTU Configuration
      // panel is immediately populated. Authors can adjust all fields via the drop-downs
      // in the Properties Panel without needing to know the schema structure.
      if (category === 'rtu' || category === 'iec104-rtu') {
        const defaultRtu: RtuConfig = {
          commType: 'cellular',
          primaryProtocol: category === 'iec104-rtu' ? 'iec-104' : 'dnp3',
          operatingMode: 'report-by-exception',
          pollIntervalSec: 60,
          powerSource: 'solar-battery'
        }
        device.rtuConfig = defaultRtu
      }

      // smart-sensor devices get a sensible default sensor config (Temperature kind,
      // sine waveform, -20..150°C) so the Sensor Configuration panel and canvas icon
      // are immediately populated. Authors pick the kind via the Properties Panel dropdown.
      if (category === 'smart-sensor') {
        device.sensor = DEFAULT_SENSOR_CONFIG
      }

      // smart-controller devices get a sensible default controller config (Pump kind)
      // so the Controller Configuration panel and canvas icon are immediately populated.
      // Authors pick the kind via the Properties Panel dropdown.
      if (category === 'smart-controller') {
        device.controller = DEFAULT_CONTROLLER_CONFIG
      }

      // 'sensor' devices always run the real otforge-bacnet container — give them
      // a default BACnet config (generic kind) so the BACnet section and Equipment
      // Kind dropdown are immediately populated, matching smart-sensor/smart-controller.
      if (category === 'sensor') {
        device.bacnet = DEFAULT_BACNET_CONFIG
      }

      // Use the pack device type's label if available; fall back to the built-in label.
      const nodeLabel = packDeviceType?.label ?? CATEGORY_LABELS[category]

      const newNode: DeviceNodeType = {
        id: nodeId,
        type: 'deviceNode',
        position,
        // Pre-declare node dimensions so edges connect correctly before DOM measurement
        width: CELL_SIZE,
        height: CELL_SIZE,
        data: { device, label: nodeLabel, zone }
      }

      setNodes(nds => [...nds, newNode])

      onScenarioChange(prev => {
        const base = prev ?? buildEmptyScenario()
        // One Kali only: insider drop replaces any existing attack-machine.
        const nodes =
          category === 'attack-machine'
            ? base.visual.nodes.filter(n => n.type !== 'attack-machine')
            : base.visual.nodes
        const devices =
          category === 'attack-machine'
            ? Object.fromEntries(
                Object.entries(base.devices.devices).filter(
                  ([, d]) => d.category !== 'attack-machine'
                )
              )
            : base.devices.devices
        return {
          ...base,
          visual: {
            ...base.visual,
            nodes: [
              ...nodes,
              {
                id: nodeId,
                type: category,
                position,
                data: { label: nodeLabel, zone }
              }
            ]
          },
          devices: {
            devices: { ...devices, [nodeId]: device }
          }
        }
      })
    },
    [setNodes, onScenarioChange, activeLayer, showGrid, scenario, readOnly, packDeviceTypes]
  )

  const isOT = activeLayer === 'ot'

  return (
    /* .connecting class switches the cursor to a crosshair when the user has
       picked a protocol and is waiting to click a target node. */
    <div
      className={`canvas-container${isOT ? ' canvas-ot' : ''}${pendingConnection ? ' connecting' : ''}`}
    >
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodesDelete={readOnly ? undefined : onNodesDelete}
        onEdgesDelete={readOnly ? undefined : onEdgesDelete}
        onConnect={readOnly ? undefined : onConnect}
        onSelectionChange={onSelectionChange}
        onNodeDragStop={readOnly ? undefined : onNodeDragStop}
        onNodeContextMenu={onNodeContextMenu}
        onNodeClick={onNodeClick}
        onEdgeClick={onEdgeClick}
        onReconnect={readOnly ? undefined : onReconnect}
        onPaneClick={cancelConnection}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        deleteKeyCode={readOnly ? null : 'Delete'}
        onInit={instance => {
          rfInstance.current = instance
          // Fit the full 25 × 25 grid immediately on mount — no setTimeout needed
          // because onInit fires exactly when the React Flow instance is ready and
          // the canvas has its final dimensions. This prevents the flash at zoom=1
          // that would otherwise appear before the useEffect fitBounds fires.
          fitCanvasView(instance)
        }}
        onDragOver={onDragOver}
        onDrop={onDrop}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: isOT ? 'pipeEdge' : 'protocolEdge', animated: false }}
        multiSelectionKeyCode="Shift"
        minZoom={0.08}
        maxZoom={2}
        snapToGrid={showGrid}
        snapGrid={[CELL_SIZE, CELL_SIZE]}
        proOptions={{ hideAttribution: true }}
      >
        {/*
         * Background grid:
         * - OT tab always uses Lines on the dark P&ID navy background.
         *   When a grid size is set, the line gap matches the snap grid so
         *   users can see exactly where nodes will snap.
         * - Other tabs use Dots (no grid) or Lines (grid active).
         */}
        {/*
         * Background pattern — shown only when the grid toggle is on.
         * When grid is off the canvas is plain (no dots, no lines) so the user
         * sees a clean workspace. Snap-to-grid is also disabled via snapToGrid={showGrid}.
         *
         * The teal color rgba(57,208,176,0.5) is the OT zone accent at 50% opacity —
         * clearly visible against both the navy OT background (#060d14) and the
         * standard dark canvas (#0d1117).
         */}
        {showGrid && (
          <Background
            variant={BackgroundVariant.Lines}
            gap={CELL_SIZE}
            color="rgba(57, 208, 176, 0.5)"
            lineWidth={1}
          />
        )}
        <Controls
          style={{ background: '#1c2128', border: '1px solid #30363d', borderRadius: 6 }}
          showInteractive={false}
        />
        <MiniMap
          style={{ background: '#0d1117', border: '1px solid #30363d', borderRadius: 6 }}
          nodeColor={node => {
            if (node.type === 'siteNode') {
              const d = node.data as unknown as SiteNodeData
              return d.region?.color ?? '#484f58'
            }
            const data = node.data as DeviceNodeData
            return ZONE_COLORS[data.zone] ?? '#484f58'
          }}
          maskColor="rgba(13, 17, 23, 0.7)"
        />
      </ReactFlow>

      {/* ── Add Field Site button (Author Mode only) ────────────────────────── */}
      {/* Floats at the top-right of the canvas area above the React Flow surface.
          Clicking opens a small dropdown with Local Site / Remote Site options.
          Closed automatically when an option is chosen or the user clicks away. */}
      {!readOnly && (
        <div className="site-add-btn-wrap">
          <button
            className="btn btn-secondary site-add-btn"
            onClick={() => setShowSiteMenu(prev => !prev)}
            title="Add a field site region to group devices by physical location"
          >
            + Field Site
          </button>
          {showSiteMenu && (
            <div className="site-add-menu">
              <button
                className="site-add-menu-item site-add-menu-item--local"
                onClick={() => handleAddSite('local')}
              >
                <span className="site-add-menu-swatch" style={{ background: '#22c55e' }} />
                Local Site
              </button>
              <button
                className="site-add-menu-item site-add-menu-item--remote"
                onClick={() => handleAddSite('remote')}
              >
                <span className="site-add-menu-swatch" style={{ background: '#f59e0b' }} />
                Remote Site
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Right-click protocol + cable selection menu ─────────────────────── */}
      {/* Rendered outside ReactFlow so it sits above the canvas SVG layer.
          Uses position:fixed so clientX/clientY coordinates work directly.
          Two sections:
            • Application Protocol — clicking immediately starts the pending connection.
            • Physical Cable       — clicking toggles a pre-selection; the menu stays open
              so the user can then click a protocol to start the connection with both set. */}
      {contextMenu && (
        <div
          className="connection-context-menu"
          style={{
            left: contextMenu.x,
            // Flip the menu above the cursor when it would overflow the bottom of the
            // viewport. Threshold at 55% of screen height gives enough room for the
            // full cable+protocol list. When flipped, `bottom` pins the menu's lower
            // edge to the cursor; when not flipped, `top` pins the upper edge.
            ...(contextMenu.y > window.innerHeight * 0.55
              ? { bottom: window.innerHeight - contextMenu.y, top: 'auto' }
              : { top: contextMenu.y, bottom: 'auto' }),
            // Hard cap + scroll so an unusually long list never escapes the viewport.
            maxHeight:
              contextMenu.y > window.innerHeight * 0.55
                ? `${contextMenu.y - 8}px`
                : `${window.innerHeight - contextMenu.y - 8}px`,
            overflowY: 'auto'
          }}
          onContextMenu={e => e.preventDefault()}
        >
          <div className="connection-context-menu-title">
            {isOT ? 'Draw Pipe Connection' : 'Connect via…'}
          </div>

          {/* ── Section 0 (OT layer only): Fluid Type pre-selection ── */}
          {isOT && (
            <>
              <div className="connection-context-menu-section-title">
                Fluid / Substance
                {contextMenu.pendingFluid && (
                  <span className="connection-context-menu-cable-hint"> — then click signal</span>
                )}
              </div>
              <div className="connection-context-menu-sep" />
              {FLUID_OPTIONS.map(opt => {
                const isSelected = contextMenu.pendingFluid === opt.fluid
                return (
                  <button
                    key={opt.fluid}
                    className={`connection-context-menu-item${isSelected ? ' connection-context-menu-item--selected' : ''}`}
                    onClick={() => selectFluid(opt.fluid)}
                  >
                    <span
                      className="connection-context-menu-dot"
                      style={{
                        background: isSelected ? opt.color : 'transparent',
                        borderColor: opt.color
                      }}
                    />
                    {opt.label}
                    {isSelected && <span className="connection-context-menu-check">✓</span>}
                  </button>
                )
              })}
              <div className="connection-context-menu-sep" style={{ marginTop: 6 }} />
            </>
          )}

          {/* ── Section 1 (normal) or Freehand sub-view ─────────────────── */}
          {contextMenu.freehandMode ? (
            /* ── Freehand sub-view ───────────────────────────────────────────── */
            <>
              <div className="connection-context-menu-section-title">Freehand Connection</div>
              <div className="connection-context-menu-sep" />
              {/* Custom label input — written into edge data.label verbatim */}
              <div style={{ padding: '2px 8px 6px' }}>
                <input
                  autoFocus
                  className="connection-context-menu-label-input"
                  placeholder="Label (optional)"
                  value={contextMenu.pendingLabel ?? ''}
                  onChange={e => updateFreehandLabel(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') startFreehandConnection()
                    if (e.key === 'Escape') cancelConnection()
                  }}
                  // Stop click from propagating to ReactFlow canvas (which would
                  // trigger onPaneClick and cancel the menu before the user is done)
                  onClick={e => e.stopPropagation()}
                />
              </div>
              <div className="connection-context-menu-sep" />
              {/* Draw button — starts the pending freehand connection */}
              <button
                className="connection-context-menu-item connection-context-menu-freehand-draw"
                onClick={startFreehandConnection}
              >
                <span style={{ marginRight: 6 }}>✏</span>
                Draw — then click target
              </button>
              <div className="connection-context-menu-sep" style={{ marginTop: 4 }} />
              <button
                className="connection-context-menu-item"
                style={{ fontSize: 12, opacity: 0.75 }}
                onClick={exitFreehandMode}
              >
                ← Back
              </button>
            </>
          ) : (
            /* ── Normal protocol + cable list ────────────────────────────────── */
            <>
              {/* Section 1: ICS Signal Protocol */}
              <div className="connection-context-menu-section-title">
                {isOT ? 'ICS Control Signal' : 'Application Protocol'}
              </div>
              <div className="connection-context-menu-sep" />
              {filteredConnectionOptions.map(opt => (
                <button
                  key={opt.protocol}
                  className="connection-context-menu-item"
                  onClick={() => startConnection(opt.protocol)}
                >
                  <span className="connection-context-menu-dot" style={{ background: opt.color }} />
                  {opt.label}
                </button>
              ))}

              {/* Section 2: Physical Cable (optional pre-selection) */}
              {filteredCableOptions.length > 0 && (
                <>
                  <div className="connection-context-menu-sep" style={{ marginTop: 6 }} />
                  <div className="connection-context-menu-section-title">
                    Physical Cable
                    {contextMenu.pendingCable && (
                      <span className="connection-context-menu-cable-hint">
                        {' '}
                        — then click protocol
                      </span>
                    )}
                  </div>
                  <div className="connection-context-menu-sep" />
                  {filteredCableOptions.map(opt => {
                    const isSelected = contextMenu.pendingCable === opt.cable
                    return (
                      <button
                        key={opt.cable}
                        className={`connection-context-menu-item${isSelected ? ' connection-context-menu-item--selected' : ''}`}
                        onClick={() => selectCable(opt.cable)}
                      >
                        <span
                          className="connection-context-menu-dot"
                          style={{
                            background: isSelected ? opt.color : 'transparent',
                            borderColor: opt.color
                          }}
                        />
                        {opt.label}
                        {isSelected && <span className="connection-context-menu-check">✓</span>}
                      </button>
                    )
                  })}
                </>
              )}

              {/* Freehand option — skips protocol validation entirely */}
              <div className="connection-context-menu-sep" style={{ marginTop: 6 }} />
              <button
                className="connection-context-menu-item connection-context-menu-freehand"
                onClick={enterFreehandMode}
              >
                <span style={{ marginRight: 6 }}>✏</span>
                Draw Freehand Connection…
              </button>
            </>
          )}

          <div className="connection-context-menu-sep" />
          <button
            className="connection-context-menu-item connection-context-menu-cancel"
            onClick={cancelConnection}
          >
            Cancel
          </button>
        </div>
      )}

      {/* ── Connecting mode hint banner ──────────────────────────────────────── */}
      {/* Shown at the bottom of the canvas while awaiting a target node click.
          Freehand mode shows a distinct amber label so students know validation
          is bypassed for this draw operation. */}
      {pendingConnection && (
        <div
          className={`connection-mode-hint${pendingConnection.freehand ? ' connection-mode-hint--freehand' : ''}`}
        >
          {pendingConnection.freehand ? (
            <>
              <span style={{ marginRight: 6 }}>✏</span>
              Freehand — click any device to connect — press <kbd>Esc</kbd> to cancel
            </>
          ) : (
            <>
              Click a device to connect — press <kbd>Esc</kbd> to cancel
            </>
          )}
        </div>
      )}

      {/* ── Invalid connection tooltip ────────────────────────────────────────── */}
      {/* Appears at the cursor position when the student clicks an incompatible   */}
      {/* target. Explains why the connection is rejected and what protocols ARE   */}
      {/* valid, so the student learns the Purdue model without reading docs.      */}
      {/* Auto-dismisses after 3 s; the pending connection stays active so the    */}
      {/* student can immediately click a valid target node instead.              */}
      {invalidTooltip && (
        <div
          className="connection-invalid-tooltip"
          style={{ left: invalidTooltip.x, top: invalidTooltip.y }}
        >
          <span className="connection-invalid-tooltip-icon">⚠</span>
          <span>{invalidTooltip.message}</span>
        </div>
      )}
    </div>
  )
}

/**
 * Minimal OTForgeScenario with all four Purdue network segments pre-defined.
 * Created when the user drops their first device onto a blank canvas.
 */
function buildEmptyScenario(): OTForgeScenario {
  return {
    meta: {
      formatVersion: '1.0',
      name: 'Untitled Scenario',
      description: '',
      sector: 'generic',
      author: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      appVersion: '0.1.0',
      locked: false,
      brief: '',
      requirements: { estimatedRamMb: 0, estimatedCpuCores: 1, containerCount: 0 }
    },
    visual: { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } },
    network: {
      // Subnets match ZONE_DEFAULTS in network-config.ts (10.200.x.x).
      // The compose generator translates these at simulation start if subnet
      // auto-detection picks a different range to avoid host interface conflicts.
      // The 'attacker' zone is omitted here — it is created automatically by the
      // compose generator when an attack-machine device is present in the scenario.
      segments: [
        { zone: 'ot', subnet: '10.200.10.0/24', gateway: '10.200.10.1', dockerNetwork: 'ot-net' },
        {
          zone: 'control',
          subnet: '10.200.20.0/24',
          gateway: '10.200.20.1',
          dockerNetwork: 'control-net'
        },
        {
          zone: 'plant-dmz',
          subnet: '10.200.30.0/24',
          gateway: '10.200.30.1',
          dockerNetwork: 'plant-dmz-net'
        },
        {
          zone: 'enterprise',
          subnet: '10.200.40.0/24',
          gateway: '10.200.40.1',
          dockerNetwork: 'enterprise-net'
        },
        {
          zone: 'internet-dmz',
          subnet: '10.200.50.0/24',
          gateway: '10.200.50.1',
          dockerNetwork: 'internet-dmz-net'
        }
      ],
      routes: []
    },
    devices: { devices: {} },
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

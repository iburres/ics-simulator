/**
 * DevicePalette.tsx — Drag-and-drop device library panel for the SCADA canvas.
 *
 * The palette is a sidebar panel on the left side of the workspace that lists all
 * available device types for the currently active Purdue layer tab. Users drag
 * items from the palette onto the canvas to add new devices to their scenario.
 *
 * Layer-aware filtering (Purdue Reference Model):
 *   OT Process (L0-L2)    — PLCs, RTUs, IEDs, field devices (sensors, actuators, pumps, etc.)
 *   Control Center (L3)   — HMIs, historians, application servers, database servers, engineering workstations
 *   Plant DMZ (L3.5)      — Firewalls, IDS/IPS, switches, routers
 *   Enterprise (L4)       — Domain controllers, web servers, business servers, enterprise desktops
 *   Internet DMZ (L5)     — Email servers, internet-facing servers
 *
 * Attack Machine is intentionally absent from the palette — the red team machine
 * is added via the dedicated "Add Attack Machine" toolbar button and launched in
 * a separate OS window when the simulation is running.
 *
 * Drag protocol:
 *   - onDragStart sets `event.dataTransfer.setData('deviceCategory', category)`
 *   - The ScadaCanvas.onDrop handler reads this value and creates a new DeviceNode
 *     assigned to the active layer (no y-coordinate zone detection needed).
 *
 * Color overrides:
 *   Security devices (Firewall, IDS/IPS) use amber to mark them as boundary devices.
 *   Enterprise/internet devices use purple and orange matching their zone accent.
 */

import type { DeviceCategory, NetworkZone, ResolvedPackDeviceType } from '@otforge/schema'
import { DeviceIcon } from '../icons/DeviceIcons'

/** Describes a group of related palette items shown under a section header. */
interface PaletteSection {
  /** Section header text displayed above the group. */
  label: string
  /** Ordered list of draggable items in this section. */
  items: { category: DeviceCategory; label: string }[]
  /** Which layers this section is shown on. Omit to show on all layers. */
  layers?: NetworkZone[]
  /**
   * When true, this section is only shown when scenario.security.insiderThreat
   * is enabled — see the "Insider Threat" section below. Omit `layers` on such
   * a section so it's eligible on every Purdue tab; DevicePalette's insiderThreatMode
   * prop is the actual gate.
   */
  insiderOnly?: boolean
}

/**
 * Master palette definition — all device categories grouped by Purdue layer and function.
 * The `layers` array restricts which tab each section appears on.
 * Order within each section reflects typical design-order for that layer.
 *
 * OT tab sections (Levels 0–2):
 *   Primary Control   — PLCs, Safety PLC, DCS Controller, RTU, IED, EtherNet/IP Adapter
 *   Field Instruments — sensor, smart sensor (kind chosen in Properties Panel;
 *                       covers temperature/gas/vibration/flow/pressure/level/
 *                       analyzer/pmu; real Modbus-backed container generates
 *                       the waveform, same image as RTU)
 *   Actuators & Drives — smart controller (kind chosen in Properties Panel;
 *                       covers pump/valve/vfd/actuator/wellhead-controller;
 *                       real Modbus-backed container, same image as RTU)
 *   IIoT / Wireless   — IIoT sensor node, IoT gateway
 *   Legacy / Protocol — Siemens S7 PLC, IEC 104 RTU
 *   Process Simulation — physics-simulated process unit
 */
const PALETTE: PaletteSection[] = [
  // ── OT Process (Levels 0–2) ────────────────────────────────────────────────
  {
    label: 'Primary Control',
    layers: ['ot'],
    items: [
      { category: 'plc', label: 'PLC' },
      { category: 'safety-plc', label: 'Safety PLC / SIS' },
      { category: 'dcs-controller', label: 'DCS Controller' },
      { category: 'rtu', label: 'RTU' },
      { category: 'ied', label: 'IED (DNP3)' },
      { category: 'iec61850-ied', label: 'IEC 61850 IED' },
      { category: 'ethernetip-adapter', label: 'EtherNet/IP Adapter' },
      { category: 'profinet-device', label: 'PROFINET Device' }
    ]
  },
  {
    label: 'Field Instruments',
    layers: ['ot'],
    items: [
      // Real otforge-bacnet container. Equipment kind (generic/AHU/VAV/chiller/
      // zone-sensor) chosen after drop in the Properties Panel BACnet section.
      { category: 'sensor', label: 'BACnet Device' },
      // Kind chosen after drop in the Properties Panel — covers temperature/gas/
      // vibration plus the consolidated former flow-meter/pressure-transmitter/
      // level-transmitter/analyzer/pmu categories.
      { category: 'smart-sensor', label: 'Smart Sensor' }
    ]
  },
  {
    label: 'Actuators & Drives',
    layers: ['ot'],
    items: [
      // Kind chosen after drop in the Properties Panel — covers the consolidated
      // former actuator/pump/valve/vfd categories plus wellhead-controller.
      { category: 'smart-controller', label: 'Smart Controller' }
    ]
  },
  {
    label: 'IIoT / Wireless',
    layers: ['ot'],
    items: [
      { category: 'iiot-sensor', label: 'IIoT Sensor' },
      { category: 'iot-gateway', label: 'IoT Gateway' }
    ]
  },
  {
    // Phase 10: Siemens S7 and IEC 104 legacy devices for fingerprinting labs.
    // Emulated by the conpot container; respond to real Nmap/Metasploit probes.
    label: 'Legacy / Protocol',
    layers: ['ot'],
    items: [
      { category: 'legacy-plc', label: 'Siemens S7 PLC' },
      { category: 'enip-plc', label: 'ControlLogix 1756-L61' }, // cpppo/scada CIP
      { category: 'iec104-rtu', label: 'IEC 104 RTU' }
    ]
  },
  {
    // Phase 11: Physics-simulated process units.
    // Each instance runs a real-time physics model (water-tank / pipeline /
    // generator / generic) in the otforge-process container. The PLC reads
    // sensor values as Modbus registers and writes control outputs back.
    label: 'Process Simulation',
    layers: ['ot'],
    items: [{ category: 'process-unit', label: 'Process Unit' }]
  },
  // ── Control Center (Level 3) ────────────────────────────────────────────────
  {
    label: 'SCADA / HMI',
    layers: ['control'],
    items: [
      { category: 'hmi', label: 'HMI' },
      { category: 'historian', label: 'Historian' },
      { category: 'scada-server', label: 'SCADA Server' }
    ]
  },
  {
    label: 'Engineering',
    layers: ['control'],
    items: [{ category: 'engineering-workstation', label: 'Eng. Workstation' }]
  },
  {
    label: 'Servers',
    layers: ['control'],
    items: [
      { category: 'application-server', label: 'App Server' },
      { category: 'database-server', label: 'DB Server' }
    ]
  },
  // ── Plant DMZ (Level 3.5) ───────────────────────────────────────────────────
  {
    label: 'Access Control',
    layers: ['plant-dmz'],
    items: [
      { category: 'jump-server', label: 'Jump Server' },
      { category: 'data-diode', label: 'Data Diode' }
    ]
  },
  {
    label: 'Security',
    layers: ['plant-dmz'],
    items: [
      { category: 'firewall', label: 'Firewall' },
      { category: 'ids-ips', label: 'IDS/IPS' }
    ]
  },
  {
    label: 'Network',
    layers: ['plant-dmz'],
    items: [
      { category: 'switch', label: 'Switch' },
      { category: 'router', label: 'Router' },
      { category: 'wap', label: 'Wireless AP' }
    ]
  },
  // ── Enterprise Zone (Level 4) ───────────────────────────────────────────────
  {
    label: 'Directory & Servers',
    layers: ['enterprise'],
    items: [
      { category: 'domain-controller', label: 'Domain Controller' },
      { category: 'web-server', label: 'Web Server' },
      { category: 'business-server', label: 'Business Server' }
    ]
  },
  {
    label: 'Endpoints',
    layers: ['enterprise'],
    items: [
      { category: 'enterprise-desktop', label: 'Enterprise Desktop' },
      { category: 'switch', label: 'Switch' },
      { category: 'router', label: 'Router' }
    ]
  },
  // ── Internet DMZ (Level 5) ───────────────────────────────────────────────────
  {
    label: 'Internet-Facing',
    layers: ['internet-dmz'],
    items: [
      { category: 'email-server', label: 'Email Server' },
      // internet-server: generic internet-facing server (e.g., company website via dockerImage override)
      { category: 'internet-server', label: 'Internet Server' },
      // dns-server: authoritative DNS for the simulated company domain (Phase 12)
      { category: 'dns-server', label: 'DNS Server' },
      // ip-camera: real otforge-camera container — weak default SSH credentials,
      // commonly deployed dual-homed (extraNetworks) into an internal zone as a pivot device
      { category: 'ip-camera', label: 'IP Camera' },
      { category: 'firewall', label: 'Firewall' }
    ]
  },
  // ── Insider Threat (scenario.security.insiderThreat only) ───────────────────
  // No `layers` restriction — eligible on every Purdue tab. Normally the attack
  // machine has no canvas node at all (added via the toolbar "Add Attack Machine"
  // button, external-attacker model — see project_network_access_architecture).
  // When insiderThreat is enabled, dragging this onto any tab places the attack
  // machine there instead, granting it real network access to that zone in
  // addition to its default attacker-net/internet-dmz-net legs (compose-generator.ts
  // reads the dropped node's zone to add this — its IP stays in the attacker
  // subnet regardless of drop location, preserving real internet/host routing).
  {
    label: 'Insider Threat',
    insiderOnly: true,
    items: [{ category: 'attack-machine', label: 'Attack Machine (Insider)' }]
  }
]

/**
 * Per-category icon color overrides for visually distinctive palette entries.
 * Categories not listed here use the default muted gray (#8b949e).
 */
const PALETTE_COLORS: Partial<Record<DeviceCategory, string>> = {
  // Phase 11 process units — green to evoke a running physical process
  'process-unit': '#56d364',
  // Safety PLC — red to immediately communicate safety-critical function
  'safety-plc': '#f85149',
  // DCS Controller — cornflower blue (primary process control)
  'dcs-controller': '#58a6ff',
  // Smart Controller — teal/cyan (motor/drive/actuator systems, consolidated from vfd)
  'smart-controller': '#3dc9b0',
  // IIoT devices — mint green (edge/cloud)
  'iiot-sensor': '#39d0b0',
  'iot-gateway': '#56d364',
  // SCADA Server — same blue family as DCS
  'scada-server': '#388bfd',
  // Legacy / Phase 10 devices — teal to distinguish from standard PLCs and RTUs
  'legacy-plc': '#39d0b0',
  'iec104-rtu': '#39d0b0',
  // Access control devices — amber (security boundary, same as firewall)
  'jump-server': '#d29922',
  'data-diode': '#d29922',
  // WAP — muted blue (network infrastructure)
  wap: '#58a6ff',
  // Security boundary devices — amber
  firewall: '#d29922',
  'ids-ips': '#d29922',
  // Enterprise devices — purple
  'domain-controller': '#a371f7',
  'web-server': '#a371f7',
  'business-server': '#a371f7',
  'enterprise-desktop': '#a371f7',
  // Internet DMZ devices — orange
  'email-server': '#f78166',
  'internet-server': '#f78166',
  // DNS server — same orange family as other Internet DMZ devices (Phase 12)
  'dns-server': '#f78166',
  'ip-camera': '#f78166',
  // Attack machine (Insider Threat mode) — matches LAYER_COLORS.attacker
  'attack-machine': '#f85149'
}

/**
 * A single draggable item in the palette.
 *
 * Sets the HTML Drag and Drop API's transfer data so ScadaCanvas.onDrop
 * can read the category and create the appropriate device node.
 *
 * @param category - The DeviceCategory this item represents.
 * @param label    - Human-readable display name.
 */
function PaletteItem({ category, label }: { category: DeviceCategory; label: string }) {
  function onDragStart(event: React.DragEvent) {
    // Pass the category string to the drop handler via the drag data store
    event.dataTransfer.setData('deviceCategory', category)
    event.dataTransfer.effectAllowed = 'copy'
  }

  const color = PALETTE_COLORS[category] ?? '#8b949e'

  return (
    <div
      className="palette-item"
      draggable
      onDragStart={onDragStart}
      title={`Drag to canvas to add a ${label}`}
    >
      <DeviceIcon category={category} size={28} color={color} />
      <span className="palette-item-label">{label}</span>
    </div>
  )
}

/**
 * A draggable palette item contributed by a community scenario pack.
 *
 * Pack device types use the same drag protocol as built-in types, but also set
 * `packDeviceTypeId` (format: `packId:typeId`) so the canvas drop handler can
 * look up the custom Docker image and label from the installed pack.
 *
 * @param deviceType - The resolved pack device type (icon pre-loaded as data URL).
 */
function PackPaletteItem({ deviceType }: { deviceType: ResolvedPackDeviceType }) {
  function onDragStart(event: React.DragEvent) {
    event.dataTransfer.setData('deviceCategory', deviceType.category)
    // Composite key so the canvas can look up the full device type definition
    event.dataTransfer.setData('packDeviceTypeId', `${deviceType.packId}:${deviceType.id}`)
    event.dataTransfer.effectAllowed = 'copy'
  }

  return (
    <div
      className="palette-item palette-item-pack"
      draggable
      onDragStart={onDragStart}
      title={`Pack device: ${deviceType.label} (${deviceType.packId})`}
    >
      {deviceType.iconDataUrl ? (
        /* Custom SVG icon supplied by the pack */
        <img
          className="palette-item-pack-icon"
          src={deviceType.iconDataUrl}
          alt={deviceType.label}
        />
      ) : (
        /* Fall back to the standard category icon when no pack icon is provided */
        <DeviceIcon category={deviceType.category} size={28} color="#58a6ff" />
      )}
      <div className="palette-item-pack-labels">
        <span className="palette-item-label">{deviceType.label}</span>
        <span className="palette-item-pack-badge">{deviceType.packId}</span>
      </div>
    </div>
  )
}

interface DevicePaletteProps {
  /** The currently active Purdue layer — controls which sections are shown. */
  activeLayer: NetworkZone
  /**
   * When true the palette is hidden — rendered as null.
   * Used in Student mode where the MissionPanel occupies the left sidebar instead.
   */
  readOnly?: boolean
  /**
   * Custom device types contributed by installed community packs.
   * Only types whose `sector` matches the active layer's zone (or whose sector is
   * undefined) are shown. Rendered as a separate "Pack Devices" section at the
   * bottom of the palette when any matching types are present.
   */
  packDeviceTypes?: ResolvedPackDeviceType[]
  /**
   * scenario.security.insiderThreat — gates the "Insider Threat" palette section
   * (the attack machine, normally added only via the toolbar button with no
   * canvas node, becomes a normal draggable item on every Purdue tab).
   */
  insiderThreatMode?: boolean
}

/**
 * Renders the device palette sidebar filtered to the active Purdue layer.
 *
 * Iterates over PALETTE sections, skipping any that don't include the current
 * layer in their `layers` array. Pack device types for the current layer are
 * shown beneath the built-in sections in a "Pack Devices" group.
 * A hint text at the bottom reminds new users of the drag interaction.
 */
export function DevicePalette({
  activeLayer,
  readOnly = false,
  packDeviceTypes = [],
  insiderThreatMode = false
}: DevicePaletteProps) {
  // In Student mode the MissionPanel occupies this column; hide the palette entirely.
  if (readOnly) return null

  const visibleSections = PALETTE.filter(
    section =>
      (!section.layers || section.layers.includes(activeLayer)) &&
      (!section.insiderOnly || insiderThreatMode)
  )

  // Filter pack device types to those whose category belongs to the active layer.
  // Uses the same zone-category mapping as the built-in palette sections so pack
  // devices always appear on the correct Purdue layer tab.
  const layerCategories = new Set(
    PALETTE.filter(s => s.layers?.includes(activeLayer)).flatMap(s => s.items.map(i => i.category))
  )
  const visiblePackTypes = packDeviceTypes.filter(dt => layerCategories.has(dt.category))

  return (
    <aside className="device-palette">
      <div className="palette-sections">
        {visibleSections.map(section => (
          <div
            key={`${section.label}-${section.layers?.join('-') ?? 'all'}`}
            className="palette-section"
          >
            <div className="palette-section-label">{section.label}</div>
            {section.items.map(item => (
              <PaletteItem key={`${item.category}-${section.label}`} {...item} />
            ))}
          </div>
        ))}

        {/* Pack device types section — only rendered when packs add types for this layer */}
        {visiblePackTypes.length > 0 && (
          <div className="palette-section palette-section-pack">
            <div className="palette-section-label palette-section-label-pack">Pack Devices</div>
            {visiblePackTypes.map(dt => (
              <PackPaletteItem key={`${dt.packId}:${dt.id}`} deviceType={dt} />
            ))}
          </div>
        )}
      </div>
      <div className="palette-hint">Drag devices onto the canvas</div>
    </aside>
  )
}

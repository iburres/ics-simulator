/**
 * ProtocolEdge.tsx — React Flow custom edge for ICS protocol connections.
 *
 * Edges on the SCADA canvas represent communication links between devices.
 * Each edge carries a Protocol tag (e.g., "modbus-tcp", "dnp3", "opc-ua") which
 * is rendered as:
 *   - A colored Bezier curve whose hue indicates the protocol family
 *   - A floating label chip at the midpoint showing the protocol name
 *
 * Protocol color coding (practitioners use these colors in real P&ID diagrams):
 *   Modbus variants  — teal  (#39d0b0) — matches OT zone color
 *   DNP3             — blue  (#388bfd) — matches IT zone color
 *   OPC UA           — amber (#d29922) — matches DMZ zone color
 *   BACnet           — green (#7ee787) — HVAC/building automation
 *   EtherNet/IP      — purple (#ce93d8) — Rockwell/Allen-Bradley
 *   IEC 61850        — pink  (#f48fb1) — substation automation
 *   none             — gray  (#484f58) — logical/unlabeled connection
 *
 * When selected, the edge strokes to white so it stands out against the colored
 * zone backgrounds regardless of which protocol color is assigned.
 *
 * The label is rendered via React Flow's EdgeLabelRenderer into a portal that
 * sits above the SVG layer — this allows HTML styling (border, padding, font)
 * rather than trying to style text inside SVG.
 */

import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type EdgeProps,
  type Edge
} from '@xyflow/react'
import type { Protocol, CableType } from '@otforge/schema'

/**
 * Data payload carried by each ProtocolEdge in the React Flow edge graph.
 * `label` is optional — when absent, the protocol name is shown as the label.
 */
export type ProtocolEdgeData = {
  /** The ICS protocol this connection uses. */
  protocol: Protocol
  /** Optional override label (e.g., "Control Loop 1"). Defaults to protocol name. */
  label?: string
  /**
   * Optional physical cable / media type for this connection.
   * When set, a second smaller chip is rendered above the protocol chip showing
   * the cable type so students can identify both the application protocol and
   * the physical medium at a glance.
   */
  cableType?: CableType
}

/** Short display labels for each cable type — shown in the cable chip. */
const CABLE_LABELS: Record<CableType, string> = {
  cat5e: 'Cat5e',
  cat6: 'Cat6',
  cat6a: 'Cat6a',
  smf: 'SMF Fiber',
  mmf: 'MMF Fiber',
  wifi: 'Wi-Fi',
  rs232: 'RS-232',
  rs485: 'RS-485',
  sata: 'SATA',
  ac: 'AC Pwr',
  dc: 'DC Pwr'
}

/**
 * Accent colors for cable type chips — visually distinct from protocol colors.
 *   Ethernet (cat5e/6/6a)  → cornflower blue   (#58a6ff)
 *   Fiber   (smf/mmf)      → golden yellow     (#e3b341)
 *   Wi-Fi                  → teal              (#3dc9b0)
 *   Serial  (rs232/rs485)  → amber             (#c9a227)
 *   SATA                   → purple            (#8b5cf6)
 *   Power   (ac/dc)        → coral red         (#ff7b72)
 */
const CABLE_COLORS: Record<CableType, string> = {
  cat5e: '#58a6ff',
  cat6: '#58a6ff',
  cat6a: '#79c0ff',
  smf: '#e3b341',
  mmf: '#e3b341',
  wifi: '#3dc9b0',
  rs232: '#c9a227',
  rs485: '#c9a227',
  sata: '#8b5cf6',
  ac: '#ff7b72',
  dc: '#ff7b72'
}

/** Typed React Flow edge shape for use with useEdgesState and EdgeTypes. */
export type ProtocolEdgeType = Edge<ProtocolEdgeData, 'protocolEdge'>

/**
 * Maps each Protocol to its accent color for the edge stroke and label border.
 * Uses Partial<Record> because future Protocol values may not have a color yet;
 * the component falls back to gray (#484f58) for unmapped protocols.
 */
const PROTOCOL_COLORS: Partial<Record<Protocol, string>> = {
  'modbus-tcp': '#39d0b0',
  'modbus-rtu': '#39d0b0',
  'modbus-ascii': '#39d0b0',
  dnp3: '#388bfd',
  'opc-ua': '#d29922',
  bacnet: '#7ee787',
  'ethernet-ip': '#ce93d8',
  iec61850: '#f48fb1',
  s7comm: '#79b8ff', // Siemens S7comm — blue (Phase 10)
  'iec-104': '#e3b341', // IEC 60870-5-104 — gold (Phase 10)
  mqtt: '#e87040', // MQTT — orange; IIoT broker-based pub/sub
  profinet: '#00a0e3', // PROFINET — Siemens/PI brand blue
  c37118: '#db61a2', // IEEE C37.118 synchrophasor — matches the pmu device's palette color
  ldap: '#a371f7', // LDAP — matches the domain-controller device's enterprise-zone palette color
  kerberos: '#a371f7', // Kerberos — same AD family color as LDAP/SMB
  smb: '#a371f7', // SMB — same AD family color as LDAP/Kerberos
  none: '#484f58'
}

/**
 * Renders a protocol-colored Bezier edge with a floating protocol label.
 *
 * Uses React Flow's `getBezierPath` to compute the SVG path data and label
 * center point. The edge itself is rendered via `BaseEdge` (an SVG <path>),
 * while the label uses `EdgeLabelRenderer` to place an HTML div via CSS transform.
 *
 * The `none` protocol renders at reduced opacity and hides its label — it
 * represents a logical or unlabeled connection (e.g., network infrastructure).
 */
export function ProtocolEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected
}: EdgeProps<ProtocolEdgeType>) {
  // Compute the SVG path string and the midpoint coordinates for the label
  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition
  })

  const protocol = data?.protocol ?? 'none'
  const color = PROTOCOL_COLORS[protocol] ?? '#484f58'
  const displayLabel = data?.label ?? protocol
  const cableType = data?.cableType
  const cableColor = cableType ? (CABLE_COLORS[cableType] ?? '#58a6ff') : undefined
  const cableLabel = cableType ? (CABLE_LABELS[cableType] ?? cableType) : undefined

  // When a cable chip is shown, offset the protocol chip slightly downward so
  // the two chips sit in a compact vertical stack centered on the edge midpoint.
  const protocolOffsetY = cableType ? 10 : 0
  const cableOffsetY = -12

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: selected ? '#e6edf3' : color,
          strokeWidth: selected ? 2 : 1.5,
          opacity: protocol === 'none' ? 0.4 : 1
        }}
      />
      {protocol !== 'none' && (
        <EdgeLabelRenderer>
          {/* Cable type chip — shown above the protocol chip when a cable is set */}
          {cableType && cableLabel && cableColor && (
            <div
              className="cable-type-chip"
              style={{
                position: 'absolute',
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + cableOffsetY}px)`,
                borderColor: cableColor,
                color: cableColor
              }}
            >
              {cableLabel}
            </div>
          )}
          {/* Protocol chip — centered on the edge midpoint (or shifted slightly down when stacked) */}
          <div
            className="protocol-edge-label"
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + protocolOffsetY}px)`,
              borderColor: color,
              color
            }}
          >
            {displayLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

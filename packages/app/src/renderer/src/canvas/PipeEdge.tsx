/**
 * PipeEdge.tsx — P&ID process-pipe style edge for the OT Process canvas.
 *
 * Used exclusively on the OT layer tab where the canvas represents a physical
 * process diagram (P&ID). Key visual differences from ProtocolEdge:
 *
 *   - Orthogonal routing (getSmoothStepPath) instead of bezier — produces the
 *     right-angle bends characteristic of piping diagrams.
 *   - Thicker stroke (3 px vs 1.5 px) to suggest physical pipe weight.
 *   - Filled arrowhead at the target, indicating flow direction.
 *   - Same protocol color scheme as ProtocolEdge so users learn one legend
 *     that applies across both OT and IT layer canvases.
 *
 * Flow state animation (when coilSource is set and simulation is running):
 *   - flowActive === true  → fluid icons travel along the pipe (or green dashes for none)
 *   - flowActive === false → red (#ef4444) solid stroke — flow stopped/blocked
 *   - flowActive undefined → default protocol color, no animation
 *
 * Fluid type icons (when fluidType is set on the edge):
 *   - Always visible: one centered icon when flow is stopped / sim not running.
 *   - Three traveling icons when flowActive === true, spaced 33% apart along the path.
 *   - fluidType 'none' (default) keeps the legacy green-dash animation for backwards
 *     compatibility with scenario files created before this field was introduced.
 *
 * Icon shapes (all rendered as inline SVG paths, centered at 0,0):
 *   electric  — yellow lightning bolt
 *   water     — blue teardrop
 *   gas       — gray cloud (also steam, pneumatic air — distinguish by edge label)
 *   oil       — dark brown teardrop
 *   chemical  — green teardrop
 *
 * The `coilSource` field identifies which PLC coil drives this pipe's state.
 * ScadaCanvas polls coil states via the `modbus:readCoils` IPC channel and
 * sets `flowActive` on each edge before passing them to React Flow.
 *
 * Protocol color mapping (matches ProtocolEdge.tsx):
 *   modbus-tcp/rtu/ascii → #39d0b0  teal   (most common OT signal)
 *   dnp3                 → #388bfd  blue
 *   opc-ua               → #d29922  amber
 *   bacnet               → #7ee787  green
 *   ethernet-ip          → #ce93d8  purple
 *   iec61850             → #f48fb1  pink
 *   none                 → #484f58  gray   (hidden label, low opacity)
 */

import { type EdgeProps, getSmoothStepPath, EdgeLabelRenderer, BaseEdge } from '@xyflow/react'
import type { Protocol, CableType, FluidType } from '@otforge/schema'

/** Short display labels for each cable type — same table as ProtocolEdge.tsx. */
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

/** Accent colors for cable type chips — same palette as ProtocolEdge.tsx. */
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

/** Pipe stroke color by protocol — matches ProtocolEdge color scheme. */
const PIPE_COLORS: Record<Protocol, string> = {
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
  mqtt: '#e87040', // MQTT — orange; IIoT sensor/gateway pub/sub
  profinet: '#00a0e3', // PROFINET — Siemens/PI brand blue
  c37118: '#db61a2', // IEEE C37.118 synchrophasor — matches the pmu device's palette color
  ldap: '#a371f7', // LDAP — matches the domain-controller device's enterprise-zone palette color
  kerberos: '#a371f7', // Kerberos — same AD family color as LDAP/SMB
  smb: '#a371f7', // SMB — same AD family color as LDAP/Kerberos
  none: '#484f58'
}

/** Short display label for each protocol — same as ProtocolEdge. */
const PROTOCOL_LABELS: Partial<Record<Protocol, string>> = {
  'modbus-tcp': 'Modbus TCP',
  'modbus-rtu': 'Modbus RTU',
  'modbus-ascii': 'Modbus ASCII',
  dnp3: 'DNP3',
  'opc-ua': 'OPC-UA',
  bacnet: 'BACnet',
  'ethernet-ip': 'EtherNet/IP',
  iec61850: 'IEC 61850',
  s7comm: 'S7comm', // Phase 10
  'iec-104': 'IEC 104', // Phase 10
  mqtt: 'MQTT', // IIoT pub/sub
  profinet: 'PROFINET'
}

/** Bright green used when a coil-driven flow is active (legacy / fluidType 'none'). */
const FLOW_ACTIVE_COLOR = '#22c55e'
/** Red used when a coil-driven flow is stopped or blocked. */
const FLOW_INACTIVE_COLOR = '#ef4444'

/**
 * Fill color for each fluid type icon.
 * The icon shape (teardrop / bolt / cloud) is shared; color distinguishes the substance.
 */
const FLUID_COLORS: Record<FluidType, string> = {
  electric: '#facc15', // yellow
  water: '#38bdf8', // sky blue
  gas: '#94a3b8', // slate gray
  oil: '#78350f', // dark brown
  chemical: '#4ade80', // green
  none: FLOW_ACTIVE_COLOR // not used directly (falls back to legacy animation)
}

/**
 * Render an SVG <g> containing the icon shape for the given fluid type.
 * The group is centered at (0, 0) so callers can apply any transform.
 * Size is fixed at ~10 px tall — suitable for placement on a 3 px pipe stroke.
 *
 * @param fluidType - Which substance to depict.
 * @param opacity   - Overall opacity passed through to the group.
 */
function FluidIcon({ fluidType, opacity = 1 }: { fluidType: FluidType; opacity?: number }) {
  const fill = FLUID_COLORS[fluidType] ?? FLOW_ACTIVE_COLOR

  if (fluidType === 'electric') {
    // Lightning bolt: top-right to centre, then sharp right-pointing spike, back up-right.
    // viewBox-equivalent: fits within ~12x14 px centered on 0,0.
    return (
      <g opacity={opacity}>
        <path d="M 2,-7 L -2,0 L 1,0 L -2,7 L 6,-1 L 3,-1 Z" fill={fill} stroke="none" />
      </g>
    )
  }

  if (fluidType === 'gas') {
    // Cloud: three overlapping circles forming a simplified cumulus shape.
    return (
      <g opacity={opacity}>
        <circle cx="-3" cy="1" r="3.5" fill={fill} stroke="none" />
        <circle cx="3" cy="1" r="3.5" fill={fill} stroke="none" />
        <circle cx="0" cy="-1.5" r="3" fill={fill} stroke="none" />
        {/* Bottom bar to close the cloud underside */}
        <rect x="-6" y="1" width="12" height="3" fill={fill} stroke="none" />
      </g>
    )
  }

  // Teardrop: shared shape for water / oil / chemical.
  // Pointed at top (–7 px), rounded at bottom (+5 px), ~6 px wide at equator.
  return (
    <g opacity={opacity}>
      <path
        d="M 0,-7 C -4,-3 -5,1 -5,3 A 5,5 0 1 0 5,3 C 5,1 4,-3 0,-7 Z"
        fill={fill}
        stroke="none"
      />
    </g>
  )
}

export interface PipeEdgeData {
  /** The ICS protocol carried by this pipe connection. */
  protocol: Protocol
  /** Optional label override — shown instead of the protocol name when set. */
  label?: string
  /**
   * Optional physical cable / media type for this pipe connection.
   * When set, a second smaller chip is rendered above the protocol chip showing
   * the cable type (e.g., "RS-485" for a Modbus RTU serial field bus).
   */
  cableType?: CableType
  /**
   * Identifies which PLC coil state drives this pipe's flow animation.
   * When set, ScadaCanvas polls the coil at runtime and writes `flowActive`.
   * When absent, the edge uses the static protocol color with no animation.
   */
  coilSource?: {
    /** nodeId of the PLC device in the scenario device map. */
    nodeId: string
    /** Zero-based coil index (Modbus FC01 address). */
    coilIndex: number
  }
  /**
   * Computed by ScadaCanvas from live Modbus coil polling.
   *   true  → coil is ON  — render as traveling fluid icons (or green dashes for none)
   *   false → coil is OFF — render as solid red (stopped)
   *   undefined → coilSource not set or simulation not running — use protocol color
   */
  flowActive?: boolean
  /**
   * Physical substance flowing through this pipe.
   * When set (and not 'none'), traveling fluid icons replace the legacy green-dash animation.
   * When absent or 'none', the legacy animation is preserved for backwards compatibility.
   */
  fluidType?: FluidType
}

/** React Flow typed edge record for PipeEdge. */
export type PipeEdgeType = {
  id: string
  source: string
  target: string
  type: 'pipeEdge'
  data: PipeEdgeData
  sourceHandle?: string | null
  targetHandle?: string | null
}

/**
 * PipeEdge — orthogonal P&ID pipe connector for the OT Process canvas.
 *
 * @param props - Standard React Flow EdgeProps with PipeEdgeData payload.
 */
export function PipeEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected
}: EdgeProps) {
  const edgeData = data as unknown as PipeEdgeData
  const protocol = edgeData?.protocol ?? 'none'
  const isNone = protocol === 'none'
  const { flowActive, coilSource, cableType, fluidType } = edgeData ?? {}
  const cableLabel = cableType ? (CABLE_LABELS[cableType] ?? cableType) : undefined
  const cableColor = cableType ? (CABLE_COLORS[cableType] ?? '#58a6ff') : undefined

  // Whether this edge uses fluid icons instead of the legacy green-dash animation.
  // 'none' (or absent) means keep the legacy behavior for backwards compatibility.
  const useFluidIcons = fluidType && fluidType !== 'none'

  // Flow state overrides the default protocol color when a coilSource is configured.
  // Three states for student feedback:
  //   flowing     = process running (coil ON)  → fluid icons traveling OR green dashes
  //   stopped     = flow blocked (coil OFF)    → solid red stroke
  //   protocol    = no coil binding            → normal protocol color, no animation
  let strokeColor: string
  let flowClass: string
  let strokeDasharray: string | undefined

  if (coilSource !== undefined) {
    if (flowActive === true) {
      // With fluid icons: keep protocol color so the pipe itself doesn't go green.
      // Without fluid icons: legacy green + animated dashes.
      strokeColor = useFluidIcons ? (PIPE_COLORS[protocol] ?? '#484f58') : FLOW_ACTIVE_COLOR
      flowClass = useFluidIcons ? '' : 'pipe-edge--active'
      strokeDasharray = useFluidIcons ? undefined : '8 4'
    } else if (flowActive === false) {
      strokeColor = FLOW_INACTIVE_COLOR
      flowClass = 'pipe-edge--inactive'
      strokeDasharray = undefined
    } else {
      // coilSource set but simulation not running — protocol color, no animation
      strokeColor = PIPE_COLORS[protocol] ?? '#484f58'
      flowClass = ''
      strokeDasharray = undefined
    }
  } else {
    strokeColor = PIPE_COLORS[protocol] ?? '#484f58'
    flowClass = ''
    strokeDasharray = isNone ? 'none' : undefined
  }

  // Orthogonal routing — getSmoothStepPath produces right-angle bends
  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 6 // Slight radius on corners to soften the right angles
  })

  // Unique marker IDs so multiple edges don't share the same arrowhead definition.
  const markerId = `pipe-arrow-${id}`
  const markerIdStart = `pipe-arrow-start-${id}`
  // ID for the hidden motion path used by <animateMotion> on fluid icon travelers.
  const motionPathId = `pipe-motion-${id}`

  const strokeWidth = 3
  const opacity = isNone ? 0.3 : selected ? 1 : 0.85
  const displayLabel = edgeData?.label ?? (isNone ? '' : (PROTOCOL_LABELS[protocol] ?? protocol))

  // For horizontal edges the label sits on the pipe stroke, so push it above.
  // For vertical edges the label crossing through the line is acceptable (no offset).
  const isHorizontalDominant = Math.abs(targetX - sourceX) >= Math.abs(targetY - sourceY)
  const labelOffsetY = isHorizontalDominant ? -16 : 0

  // Travel duration for fluid icons — 3 seconds for one full traversal.
  const travelDuration = '3s'
  // Icon opacity: slightly transparent so they don't overpower the pipe.
  const iconOpacity = 0.9

  return (
    <>
      {/* SVG defs: arrowhead markers + hidden motion path for fluid icon animation.
          Both arrowhead triangles use the same geometry (M0,0 L0,6 L8,3).
          refX="6" for target end; refX="2" for source end. */}
      <defs>
        <marker
          id={markerIdStart}
          markerWidth="8"
          markerHeight="8"
          refX="2"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,6 L8,3 z" fill={strokeColor} opacity={opacity} />
        </marker>
        <marker
          id={markerId}
          markerWidth="8"
          markerHeight="8"
          refX="6"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L0,6 L8,3 z" fill={strokeColor} opacity={opacity} />
        </marker>
        {/* Hidden duplicate of the edge path — <animateMotion> references this via mpath.
            The visible pipe is rendered by BaseEdge; this copy is display:none so it
            provides motion geometry without adding an extra visible stroke. */}
        {useFluidIcons && <path id={motionPathId} d={edgePath} style={{ display: 'none' }} />}
      </defs>

      {/* Pipe body */}
      <BaseEdge
        id={id}
        path={edgePath}
        style={{
          stroke: strokeColor,
          strokeWidth,
          opacity,
          markerStart: `url(#${markerIdStart})`,
          markerEnd: `url(#${markerId})`,
          strokeDasharray
        }}
        className={`pipe-edge${isNone ? ' pipe-edge--none' : ''}${flowClass ? ` ${flowClass}` : ''}`}
      />

      {/* Fluid icons — only rendered when fluidType is set and not 'none' */}
      {useFluidIcons && fluidType && (
        <>
          {flowActive === true ? (
            // Active flow: three icons travel along the path, each offset by 1/3 of the duration.
            // begin="0s" / "1s" / "2s" with dur="3s" means they are perpetually 33% apart.
            <>
              <g>
                <FluidIcon fluidType={fluidType} opacity={iconOpacity} />
                <animateMotion dur={travelDuration} repeatCount="indefinite" begin="0s">
                  <mpath href={`#${motionPathId}`} />
                </animateMotion>
              </g>
              <g>
                <FluidIcon fluidType={fluidType} opacity={iconOpacity} />
                <animateMotion dur={travelDuration} repeatCount="indefinite" begin="1s">
                  <mpath href={`#${motionPathId}`} />
                </animateMotion>
              </g>
              <g>
                <FluidIcon fluidType={fluidType} opacity={iconOpacity} />
                <animateMotion dur={travelDuration} repeatCount="indefinite" begin="2s">
                  <mpath href={`#${motionPathId}`} />
                </animateMotion>
              </g>
            </>
          ) : (
            // Stopped / no simulation: one static icon at the pipe midpoint.
            // Shows what's in the pipe even when nothing is flowing.
            <g transform={`translate(${labelX}, ${labelY})`}>
              <FluidIcon fluidType={fluidType} opacity={0.6} />
            </g>
          )}
        </>
      )}

      {/* Protocol + cable label chips — only shown for named protocols */}
      {!isNone && displayLabel && (
        <EdgeLabelRenderer>
          {cableType && cableLabel && cableColor && (
            <div
              className="cable-type-chip"
              style={{
                position: 'absolute',
                transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + labelOffsetY - 20}px)`,
                borderColor: cableColor,
                color: cableColor,
                pointerEvents: 'all'
              }}
            >
              {cableLabel}
            </div>
          )}
          <div
            className={`pipe-edge-label${selected ? ' selected' : ''}`}
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY + labelOffsetY + (cableType ? 8 : 0)}px)`,
              borderColor: strokeColor,
              color: strokeColor,
              pointerEvents: 'all'
            }}
          >
            {displayLabel}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  )
}

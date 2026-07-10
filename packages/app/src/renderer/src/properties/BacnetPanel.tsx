/**
 * BacnetPanel.tsx — BACnet equipment kind picker for the Properties Panel.
 *
 * The `sensor` device category always runs the real otforge-bacnet container
 * (containers/bacnet/server.py). Rather than a separate DeviceCategory per
 * piece of building-automation equipment, it carries a single `kind` field
 * (generic/ahu/vav/chiller/zone-sensor) selected here via dropdown — the
 * container's BACnet object list (which points exist, which are writable,
 * and which writable points cascade to a status readback) follows that
 * choice automatically. This mirrors SensorPanel's smart-sensor kind picker
 * for the same reason: adding a future equipment kind stays a config-only
 * change on the container side, no new DeviceCategory needed.
 *
 * Author Mode: kind is an editable dropdown, committed immediately.
 * Student Mode (readOnly): kind rendered as a read-only badge.
 */

import { useEffect, useState } from 'react'
import type { BacnetConfig } from '@otforge/schema'

type BacnetKind = NonNullable<BacnetConfig['kind']>

const KIND_OPTIONS: { value: BacnetKind; label: string; description: string }[] = [
  {
    value: 'generic',
    label: 'Generic',
    description: 'Temperature, pressure, flow, tank level, pump, valve (read-only)'
  },
  {
    value: 'ahu',
    label: 'Air Handling Unit (AHU)',
    description: 'Supply/return air temp, writable setpoint, writable fan command'
  },
  {
    value: 'vav',
    label: 'VAV Box',
    description: 'Zone temp, airflow, writable setpoint, writable damper position'
  },
  {
    value: 'chiller',
    label: 'Chiller',
    description: 'Chilled water supply/return temp, writable setpoint, writable command'
  },
  {
    value: 'zone-sensor',
    label: 'Zone Sensor',
    description: 'Temperature, humidity, CO2, occupancy (read-only)'
  }
]

/**
 * Sensible default BACnet config used when a new BACnet device (category
 * 'sensor') is first dropped onto the canvas and no config exists yet.
 * deviceInstance 1001 matches this project's other scenarios' convention
 * (see ICS_Lab_02); authors should change it if they add more than one
 * BACnet device to the same scenario, since instances must be unique.
 */
export const DEFAULT_BACNET_CONFIG: BacnetConfig = {
  deviceInstance: 1001,
  port: 47808,
  kind: 'generic'
}

interface BacnetPanelProps {
  /** Current BACnet configuration (may be undefined if the device predates this feature). */
  bacnetConfig?: BacnetConfig
  /** Node ID of the device — passed through to the onChange callback. */
  nodeId: string
  /** When true, kind is rendered as read-only text (Student Mode). */
  readOnly: boolean
  /** Called with the complete updated BacnetConfig whenever the kind changes. */
  onChange?: (nodeId: string, config: BacnetConfig) => void
}

/** Kind dropdown for a BACnet device. Device Instance / Port stay display-only, matching how DNP3/OPC UA config is shown elsewhere in this panel. */
export function BacnetPanel({ bacnetConfig, nodeId, readOnly, onChange }: BacnetPanelProps) {
  const [kind, setKind] = useState<BacnetKind>(bacnetConfig?.kind ?? 'generic')

  useEffect(() => {
    setKind(bacnetConfig?.kind ?? 'generic')
  }, [nodeId]) // eslint-disable-line react-hooks/exhaustive-deps

  function handleKindChange(next: BacnetKind): void {
    setKind(next)
    if (bacnetConfig) onChange?.(nodeId, { ...bacnetConfig, kind: next })
  }

  const option = KIND_OPTIONS.find(o => o.value === kind)

  return (
    <div className="prop-row">
      <span className="prop-label">Equipment Kind</span>
      {readOnly ? (
        <span className="prop-value">{option?.label ?? kind}</span>
      ) : (
        <select
          className="rtu-select"
          value={kind}
          onChange={e => handleKindChange(e.target.value as BacnetKind)}
        >
          {KIND_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {option && <div className="prop-hint">{option.description}</div>}
    </div>
  )
}

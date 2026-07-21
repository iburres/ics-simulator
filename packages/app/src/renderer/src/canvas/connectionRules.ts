/**
 * connectionRules.ts — ICS protocol compatibility matrix for connection validation.
 *
 * Defines which protocols are architecturally valid between device categories in
 * the Purdue Reference Model (ISA-99 / IEC 62443-3-2). Used by ScadaCanvas to
 * enforce realistic ICS topologies: invalid connections are blocked at the moment
 * the student clicks a target, and an educational tooltip explains why.
 *
 * Design rules encoded here:
 *
 *   Field devices (sensor / actuator / pump / valve / flow-meter /
 *   pressure-transmitter) are Modbus slaves. They speak only to a Modbus master
 *   (PLC, RTU) or a DNP3 outstation via an IED. They have no HMI-facing or
 *   historian-facing protocols — connecting a sensor directly to an HMI is a
 *   common student error and should be blocked with an explanation.
 *
 *   PLCs aggregate field data and expose it upward:
 *     - Modbus RTU/TCP/ASCII to field devices (master role)
 *     - EtherNet/IP to Allen-Bradley I/O and peer PLCs
 *     - OPC-UA or Modbus TCP to HMI and Historian
 *
 *   RTUs are remote concentrators for DNP3/Modbus over serial or TCP:
 *     - Modbus RTU/TCP, DNP3 to field devices
 *     - DNP3 upward to the SCADA master (HMI / Historian)
 *
 *   IEDs implement IEC 61850 and DNP3 for substation automation:
 *     - IEC 61850 GOOSE/MMS between IEDs (peer protection scheme)
 *     - DNP3 to RTU, PLC, or SCADA master
 *
 *   HMI and Historian sit on the IT layer and read process data via OPC-UA,
 *   DNP3 polling, or Modbus TCP — they never write Modbus to field devices
 *   directly (that would bypass the PLC safety layer).
 *
 *   Infrastructure devices (firewall, IDS/IPS, switch, router) are pure Ethernet
 *   pass-through; they do not speak any ICS application protocol.
 *
 *   Attack machines can inject any protocol as part of red-team exercises —
 *   they appear in the External zone and can "attempt" any connection.
 *
 * Sources:
 *   IEC 62443-3-3:2013 — System Security Requirements and Security Levels
 *   NIST SP 800-82 Rev 3 — Guide to OT Security
 *   IEEE Std 1646-2004 — Communication Delivery Time Performance Requirements for EPSS
 *   IEC 61850-8-1 — GOOSE/MMS over Ethernet
 *   DNP3 Subset Definition (DNP3 Technical Committee, 2012)
 *   Modbus Application Protocol Specification v1.1b3 (Modbus Organization)
 *   OPC Unified Architecture Part 1 (OPC Foundation)
 */

import type { DeviceCategory, Protocol, CableType } from '@otforge/schema'

/**
 * The ICS device category compatibility matrix.
 *
 * VALID_CONNECTIONS[source][target] = Protocol[]
 *   source  — category of the device that was right-clicked (connection initiator)
 *   target  — category of the device the student clicks as the destination
 *   value   — ordered list of valid protocols (first = most common / recommended)
 *
 * An undefined source key means that device type cannot initiate connections
 * to any device that isn't already listed (treated the same as an empty array).
 * A missing inner target key means the pair is incompatible — blocked.
 *
 * 'none' = untagged Ethernet cable (infrastructure pass-through; no application-layer protocol).
 */
export const VALID_CONNECTIONS: Partial<
  Record<DeviceCategory, Partial<Record<DeviceCategory, Protocol[]>>>
> = {
  // ── PLC (Modbus master, EtherNet/IP peer, OPC-UA server upward) ────────────
  plc: {
    sensor: ['modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'ethernet-ip'],
    'smart-controller': ['modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'ethernet-ip'],
    'smart-sensor': ['modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'opc-ua'],
    rtu: ['modbus-tcp', 'modbus-rtu', 'dnp3'],
    ied: ['modbus-tcp', 'iec61850'],
    'iec61850-ied': ['iec61850'],
    'ethernetip-adapter': ['ethernet-ip'], // PLC is the EtherNet/IP scanner for remote I/O
    'profinet-device': ['profinet'], // PLC is the PROFINET IO Controller for this IO device
    plc: ['modbus-tcp', 'ethernet-ip'], // peer-to-peer PLC network
    'safety-plc': ['ethernet-ip', 'modbus-tcp'], // PLC shares data with adjacent SIS
    'legacy-plc': ['s7comm', 'modbus-tcp'], // PLC → Siemens S7 peer (Phase 10)
    'enip-plc': ['ethernet-ip'], // PLC → Logix CIP peer
    'iec104-rtu': ['modbus-tcp', 'modbus-rtu'], // PLC → IEC 104 RTU (Phase 10)
    'process-unit': ['modbus-tcp', 'modbus-rtu'], // PLC polls process simulation (Phase 11)
    hmi: ['modbus-tcp', 'opc-ua'],
    historian: ['modbus-tcp', 'opc-ua'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── RTU (remote terminal unit — serial concentrator for field and SCADA) ────
  rtu: {
    sensor: ['modbus-rtu', 'modbus-tcp', 'dnp3'],
    'smart-controller': ['modbus-rtu', 'modbus-tcp', 'dnp3'],
    'smart-sensor': ['modbus-rtu', 'modbus-tcp', 'dnp3'], // includes former pmu (RTU collects via DNP3/Modbus)
    plc: ['modbus-tcp', 'modbus-rtu', 'dnp3'],
    'legacy-plc': ['s7comm', 'modbus-tcp'], // RTU → Siemens S7 peer (Phase 10)
    'iec104-rtu': ['iec-104', 'modbus-tcp'], // RTU → IEC 104 RTU peer (Phase 10)
    'process-unit': ['modbus-tcp', 'modbus-rtu'], // RTU polls process simulation (Phase 11)
    ied: ['dnp3', 'iec61850'],
    'iec61850-ied': ['iec61850'],
    hmi: ['dnp3', 'modbus-tcp'],
    historian: ['dnp3'],
    'scada-server': ['dnp3', 'modbus-tcp'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── IED (substation IEC 61850 — peer protection + DNP3 telemetry) ──────────
  ied: {
    ied: ['iec61850', 'dnp3'], // GOOSE between peer IEDs
    rtu: ['iec61850', 'dnp3'],
    plc: ['iec61850', 'modbus-tcp'],
    'smart-sensor': ['iec61850', 'dnp3'], // includes former pmu — IED receives synchrophasor data
    'legacy-plc': ['s7comm'], // IED → Siemens S7 (S7comm read, Phase 10)
    'iec104-rtu': ['iec-104', 'dnp3'], // IED → IEC 104 RTU (Phase 10)
    hmi: ['dnp3', 'iec61850'],
    historian: ['dnp3', 'iec61850'],
    'scada-server': ['dnp3', 'iec61850'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── IEC 61850 IED (dedicated real MMS server — libiec61850, port 102) ──────
  // Unlike the generic 'ied' stub (which speaks DNP3/IEC61850/S7comm depending on
  // scenario), this device is a single-protocol substation IED: MMS client/server
  // only. GOOSE/Sampled Values are deferred (layer-2 multicast, impractical on
  // Docker bridges) so no peer-to-peer entry exists yet — see containers/iec61850/.
  'iec61850-ied': {
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── EtherNet/IP (CIP) remote I/O adapter — scanned by a PLC, not a peer ────
  // Models a real remote I/O block (POINT I/O, FLEX I/O, a PowerFlex drive's I/O
  // interface) rather than a full PLC. Explicit messaging only (no Class 1 cyclic
  // I/O — see containers/ethernetip/server.py) — the adapter itself never
  // initiates a connection, it only responds to its scanning PLC.
  'ethernetip-adapter': {
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── EtherNet/IP Logix PLC (cpppo/scada) — CIP scanner / tag endpoint ─────
  'enip-plc': {
    'smart-controller': ['ethernet-ip'], // pumps/valves → edge-derived BOOL tags
    'smart-sensor': ['ethernet-ip'],
    'ethernetip-adapter': ['ethernet-ip'], // remote I/O
    plc: ['ethernet-ip'], // peer OpenPLC / ENIP3-style link
    hmi: ['ethernet-ip'],
    'engineering-workstation': ['none', 'ethernet-ip'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── PROFINET IO device (real DCP only — see containers/profinet/) ──────────
  // Discovery and Configuration Protocol only: device identify plus the
  // unauthenticated station-name/IP "Set" requests. AR establishment and RT
  // cyclic I/O are deferred, so — like the EtherNet/IP adapter above — this
  // device only responds to its IO Controller (PLC), it never initiates.
  'profinet-device': {
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── IP camera (real container — see containers/camera/) ────────────────────
  // A dual-homed IoT device: primary zone is wherever it's placed (typically
  // Internet DMZ, representing internet-facing exposure), with an extraNetworks
  // leg into another zone (typically Control) modeling the common real-world
  // misconfiguration of a "convenience" camera bridging a supposedly isolated
  // segment. No ICS application protocol — the exploitable surface is weak/
  // default SSH credentials, not a Purdue-model canvas connection.
  'ip-camera': {
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── Safety PLC / SIS (IEC 61511 safety instrumented system) ─────────────────
  // The SIS is architecturally ISOLATED from the basic process control system
  // (BPCS/PLC). It only accepts read connections upward (HMI/historian view its
  // status) and controls field safety elements (shutdown valves, ESD actuators).
  // SIS → standard PLC data sharing is intentionally restricted to Ethernet only —
  // serial cross-connections violate ISA-84 separation requirements.
  'safety-plc': {
    sensor: ['modbus-tcp', 'modbus-rtu', 'ethernet-ip'],
    'smart-controller': ['modbus-tcp', 'modbus-rtu', 'ethernet-ip'], // final element ESD valve/relay
    'smart-sensor': ['modbus-tcp', 'modbus-rtu'],
    plc: ['ethernet-ip', 'modbus-tcp'], // read-only status sharing with BPCS
    hmi: ['modbus-tcp', 'opc-ua'], // operator visibility (read-only view of SIS status)
    historian: ['opc-ua'], // safety event logging
    'engineering-workstation': ['none'], // SIS programming and configuration access
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── DCS Controller (Distributed Control System — process industry workhorse) ──
  // DCS controllers are the primary control layer in oil/gas, chemical, and power
  // generation plants. Unlike PLCs (scan-cycle), DCS controllers are event-driven
  // and tightly integrated with their I/O subsystems via a proprietary backplane.
  // Outward-facing communication follows OPC-UA (upward to historian/HMI) and
  // Modbus/serial (downward to legacy field instruments).
  'dcs-controller': {
    sensor: ['modbus-tcp', 'modbus-rtu', 'opc-ua'],
    // Includes former vfd/actuator/pump/valve (Stuxnet manipulated Siemens VFDs this way)
    'smart-controller': ['modbus-tcp', 'modbus-rtu', 'ethernet-ip'],
    'smart-sensor': ['modbus-tcp', 'modbus-rtu', 'opc-ua'],
    rtu: ['modbus-tcp'],
    plc: ['opc-ua', 'modbus-tcp'], // data exchange with adjacent PLC system
    hmi: ['opc-ua', 'modbus-tcp'],
    historian: ['opc-ua', 'modbus-tcp'],
    'scada-server': ['opc-ua', 'modbus-tcp'],
    'engineering-workstation': ['none'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── HMI (reads process data; sits on IT layer above PLC/RTU/IED) ───────────
  hmi: {
    plc: ['modbus-tcp', 'opc-ua'],
    rtu: ['dnp3', 'modbus-tcp'],
    ied: ['dnp3', 'iec61850'],
    'iec61850-ied': ['iec61850'],
    'safety-plc': ['modbus-tcp', 'opc-ua'], // HMI shows SIS status (read-only)
    'dcs-controller': ['opc-ua', 'modbus-tcp'],
    'legacy-plc': ['s7comm', 'opc-ua'], // HMI reads Siemens S7 via S7comm or OPC-UA (Phase 10)
    'enip-plc': ['ethernet-ip'], // HMI reads Logix CIP tags
    'iec104-rtu': ['iec-104'], // HMI reads IEC 104 RTU (Phase 10)
    'process-unit': ['modbus-tcp'], // HMI reads process simulation PVs (Phase 11)
    'scada-server': ['opc-ua', 'none'], // HMI pulls display data from SCADA server
    historian: ['opc-ua', 'none'],
    sensor: ['bacnet'], // HMI reads BACnet building-automation devices directly
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── Historian (time-series archive — reads from control layer, serves IT) ───
  historian: {
    plc: ['opc-ua', 'modbus-tcp'],
    rtu: ['dnp3'],
    ied: ['dnp3', 'iec61850'],
    'iec61850-ied': ['iec61850'],
    'safety-plc': ['opc-ua'], // logs safety system events
    'dcs-controller': ['opc-ua', 'modbus-tcp'],
    'smart-sensor': ['opc-ua', 'modbus-tcp', 'dnp3'], // includes former analyzer/pmu
    sensor: ['bacnet'], // Historian archives BACnet building-automation data
    'iot-gateway': ['mqtt', 'opc-ua'], // IIoT time-series data
    'legacy-plc': ['s7comm', 'opc-ua'], // Historian archives Siemens S7 data (Phase 10)
    'iec104-rtu': ['iec-104'], // Historian archives IEC 104 RTU data (Phase 10)
    'process-unit': ['modbus-tcp'], // Historian archives process simulation data (Phase 11)
    hmi: ['opc-ua', 'none'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── SCADA Server / Master Station ────────────────────────────────────────────
  // The SCADA server is the polling engine and data concentrator: it dispatches
  // FC03/FC04 reads to PLCs and RTUs on the WAN, stores current-value data, and
  // serves displays to HMI clients. It is architecturally distinct from the HMI
  // (operator console). Compromise of the SCADA server gives an attacker live
  // visibility into all polled RTUs before they move laterally into the OT network.
  'scada-server': {
    plc: ['modbus-tcp', 'opc-ua', 'dnp3'],
    rtu: ['dnp3', 'modbus-tcp'],
    ied: ['iec61850', 'dnp3'],
    'iec61850-ied': ['iec61850'],
    'dcs-controller': ['opc-ua', 'modbus-tcp'],
    'safety-plc': ['opc-ua', 'modbus-tcp'],
    'smart-sensor': ['dnp3', 'opc-ua'], // includes former pmu
    sensor: ['bacnet'], // SCADA server polls BACnet building-automation devices directly
    'iot-gateway': ['opc-ua', 'mqtt'],
    'legacy-plc': ['s7comm', 'opc-ua'], // Phase 10
    'iec104-rtu': ['iec-104'], // Phase 10
    hmi: ['opc-ua', 'none'],
    historian: ['opc-ua', 'none'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── Physics process unit (Modbus TCP server — PLC polls it) ──────────────────
  // Phase 11: The process-unit container exposes a Modbus TCP server. The PLC is
  // the Modbus master — it reads sensor registers and writes control coils/setpoints.
  //
  // P&ID physical connections: on a real P&ID diagram, physical pipe and signal
  // connections run between the process vessel and the field devices attached to it
  // (inlet pump feeds the tank, outlet valve drains it, sensors measure it). These
  // are drawn as process-unit ↔ field-device edges with a fluidType that conveys
  // the substance (water, electric signal, etc.). Use 'modbus-tcp' for fluid/signal
  // connections so the pipe renders at full opacity with animated icons; 'none' is
  // also permitted for untagged physical connections.
  'process-unit': {
    sensor: ['modbus-tcp', 'none'], // sensor measures vessel (e.g., level sensor on tank)
    // Includes former pump/valve/actuator — pipe / control valve / ESD damper attached to vessel
    'smart-controller': ['modbus-tcp', 'none'],
    // Includes former flow-meter/level-transmitter/pressure-transmitter/analyzer
    'smart-sensor': ['modbus-tcp', 'none'],
    'process-unit': ['modbus-tcp', 'none'], // vessel-to-vessel pipe (e.g., tank feeds reactor)
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── Siemens S7 legacy PLC (S7comm primary, Modbus to field devices) ─────────
  // Phase 10: Siemens S7-300/400/1200/1500 emulated by conpot container.
  // S7comm (port 102) is the primary upward protocol; the S7 also acts as a
  // Modbus master to poll classic Modbus field devices.
  'legacy-plc': {
    sensor: ['s7comm', 'modbus-tcp', 'modbus-rtu'],
    'smart-controller': ['s7comm', 'modbus-tcp', 'modbus-rtu'],
    'smart-sensor': ['s7comm', 'modbus-tcp', 'modbus-rtu'],
    plc: ['s7comm', 'modbus-tcp'], // peer PLC
    rtu: ['s7comm', 'modbus-tcp'], // upward to SCADA RTU
    ied: ['s7comm'], // IED in substation
    'legacy-plc': ['s7comm'], // Siemens peer-to-peer S7comm
    'iec104-rtu': ['modbus-tcp'], // feeds data to IEC 104 RTU
    hmi: ['s7comm', 'opc-ua', 'modbus-tcp'],
    historian: ['s7comm', 'opc-ua', 'modbus-tcp'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── IEC 60870-5-104 RTU (IEC 104 to SCADA; Modbus to field devices) ─────────
  // Phase 10: telecontrol RTU emulated by conpot container on port 2404.
  // Collects measurements from Modbus field devices and reports them to the
  // SCADA master (HMI/Historian) using the IEC 104 telecontrol protocol.
  'iec104-rtu': {
    sensor: ['modbus-rtu', 'modbus-tcp'],
    'smart-controller': ['modbus-rtu', 'modbus-tcp'],
    'smart-sensor': ['modbus-rtu', 'modbus-tcp'],
    plc: ['iec-104', 'modbus-tcp'], // peer PLC / SCADA master
    rtu: ['iec-104'], // peer RTU (RTU concentrator chain)
    ied: ['iec-104', 'dnp3'], // IED in same zone
    'legacy-plc': ['iec-104'], // Siemens S7 in same zone
    'iec104-rtu': ['iec-104'], // peer IEC 104 RTU
    hmi: ['iec-104'], // SCADA master reads RTU
    historian: ['iec-104'], // Historian archives RTU data
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── Field devices — Modbus slaves, polled by PLC, RTU, DCS, or SIS master ───
  // Note: field devices do NOT connect to HMI/Historian directly; all process
  // data must flow through a PLC, RTU, or DCS controller (a common student error).
  // ── Field devices — Modbus slaves + P&ID physical connections ───────────────
  //
  // Two connection types coexist on the OT layer canvas:
  //
  //   Protocol connections (PLC/RTU → field device): Modbus TCP/RTU polling and
  //     coil writes that represent the digital control signal. These are the
  //     connections students learn to attack (e.g., Modbus coil write attack).
  //
  //   P&ID physical connections (field device ↔ process-unit / field device):
  //     Physical pipe, mechanical, or analog signal connections that show up on
  //     a real P&ID drawing. e.g., Pump → Tank (fluid pipe), Valve → Actuator
  //     (mechanical stem), Sensor → Process-Unit (measurement tap).
  //     Use 'modbus-tcp' so the pipe renders at full opacity with fluid icons;
  //     'none' is also permitted for untagged physical connections.
  //
  // Note: field devices do NOT connect directly to HMI/Historian —
  // all process data flows through a PLC, RTU, or DCS (common student error).
  sensor: {
    plc: ['modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'ethernet-ip'],
    rtu: ['modbus-rtu', 'modbus-tcp', 'dnp3'],
    ied: ['dnp3'],
    'safety-plc': ['modbus-tcp', 'modbus-rtu', 'ethernet-ip'],
    'dcs-controller': ['modbus-tcp', 'modbus-rtu', 'opc-ua'],
    'legacy-plc': ['s7comm', 'modbus-tcp', 'modbus-rtu'],
    'iec104-rtu': ['modbus-rtu', 'modbus-tcp'],
    'iot-gateway': ['mqtt', 'modbus-tcp'],
    'process-unit': ['modbus-tcp', 'none'], // P&ID: sensor mounted on / measuring the vessel
    'smart-controller': ['modbus-tcp', 'none'], // P&ID: positioner feedback — sensor reads actuator position
    // BACnet building-automation devices (containers/bacnet) talk directly to the
    // BAS head-end — unlike Modbus field devices, BACnet/IP doesn't need a PLC/RTU
    // concentrator in between.
    hmi: ['bacnet'],
    historian: ['bacnet'],
    'scada-server': ['bacnet'],
    'engineering-workstation': ['none', 'bacnet'],
    switch: ['none'],
    router: ['none']
  },

  // ── Smart Controller (consolidated pump/valve/vfd/actuator — real Modbus container) ──
  // Configurable field controller (kind chosen in Properties Panel). Accepts speed/
  // position/setpoint writes from a master PLC/RTU/DCS/SIS via Modbus or EtherNet/IP
  // and reports status — same role the former pump/valve/vfd/actuator categories played.
  // The Stuxnet worm manipulated Siemens VFDs by replaying Modbus write commands this way.
  'smart-controller': {
    plc: ['modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'ethernet-ip'],
    rtu: ['modbus-rtu', 'modbus-tcp'],
    ied: ['dnp3'],
    'safety-plc': ['modbus-tcp', 'modbus-rtu', 'ethernet-ip'],
    'dcs-controller': ['modbus-tcp', 'modbus-rtu', 'ethernet-ip'],
    'enip-plc': ['ethernet-ip'], // draw field → Logix (tags also work Logix → field)
    'legacy-plc': ['s7comm', 'modbus-tcp', 'modbus-rtu'],
    'iec104-rtu': ['modbus-rtu', 'modbus-tcp'],
    'process-unit': ['modbus-tcp', 'none'], // P&ID: pump/valve/actuator attached to vessel
    sensor: ['modbus-tcp', 'none'], // P&ID: positioner feedback sensor
    'smart-sensor': ['modbus-tcp', 'none'], // P&ID: adjacent inline instrument
    'smart-controller': ['modbus-tcp', 'none'] // P&ID: adjacent actuator/valve/pump on same line
  },

  // ── Smart Sensor (consolidated flow-meter/pressure/level/analyzer/pmu) ────────
  // Configurable field instrument (kind chosen in Properties Panel). Real otforge-modbus
  // container generates the waveform itself, exposed to the PLC/RTU/historian as a Modbus
  // register (or DNP3/OPC-UA for the former pmu/analyzer paths). Slower-cycling kinds
  // (analyzer) and synchrophasor kinds (pmu) reuse the same transport, simplified for lab
  // purposes — see containers/modbus/server.py and SensorConfig in icslab.ts.
  'smart-sensor': {
    plc: ['modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'opc-ua'],
    rtu: ['modbus-rtu', 'modbus-tcp', 'dnp3'],
    ied: ['dnp3', 'iec61850'],
    'safety-plc': ['modbus-tcp', 'modbus-rtu'],
    'dcs-controller': ['modbus-tcp', 'modbus-rtu', 'opc-ua'],
    'enip-plc': ['ethernet-ip'],
    'legacy-plc': ['s7comm', 'modbus-tcp', 'modbus-rtu'],
    'iec104-rtu': ['modbus-rtu', 'modbus-tcp'],
    historian: ['opc-ua', 'modbus-tcp', 'dnp3'],
    'scada-server': ['dnp3', 'opc-ua'],
    'iot-gateway': ['mqtt', 'modbus-tcp'],
    'process-unit': ['modbus-tcp', 'none'], // P&ID: instrument mounted on vessel
    'smart-controller': ['modbus-tcp', 'none'] // P&ID: instrument inline with pump/valve
  },

  // ── IIoT Wireless Sensor Node ────────────────────────────────────────────────
  // Battery- or loop-powered wireless sensor that publishes process values to an
  // IoT gateway via WirelessHART, ISA100.11a, or generic MQTT over 802.11.
  // Does NOT connect directly to PLCs/historians — the gateway aggregates traffic.
  'iiot-sensor': {
    'iot-gateway': ['mqtt'], // primary path: wireless publish to gateway
    wap: ['none'] // wireless association with the access point
  },

  // ── IoT / IIoT Gateway ────────────────────────────────────────────────────────
  // Receives MQTT/Modbus from wireless sensors and field devices, re-publishes
  // upward to historian or SCADA server via OPC-UA or MQTT. Acts as a protocol
  // bridge at the L2/L3 boundary. A compromise here exposes all connected wireless
  // field devices to the IT network and is an excellent lateral-movement scenario.
  'iot-gateway': {
    'iiot-sensor': ['mqtt'], // collects from wireless sensor nodes
    sensor: ['modbus-tcp', 'modbus-rtu'], // also polls wired Modbus sensors
    'smart-sensor': ['mqtt', 'modbus-tcp'], // includes former analyzer
    historian: ['mqtt', 'opc-ua'], // pushes time-series upward
    'scada-server': ['mqtt', 'opc-ua'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none']
  },

  // ── DNS server — authoritative resolver for meridian-process.com ─────────────
  // Phase 12: Passive server; only infrastructure devices connect to it on the
  // canvas. It does not initiate ICS connections — all entries use 'none' (Ethernet).
  // The attack machine can query it via dig/nslookup; those queries traverse the
  // router/firewall and are modeled by the attack-machine → dns-server edge below.
  'dns-server': {
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── Jump Server / Bastion Host ────────────────────────────────────────────────
  // The jump server is the single hardened entry point for all remote sessions into
  // the OT network. All traffic is 'none' (untagged Ethernet) — the jump server is
  // an access-control device, not an ICS protocol endpoint. MITRE ATT&CK ICS T0822
  // (Exploitation of Remote Services) typically targets this device first.
  'jump-server': {
    plc: ['none'],
    rtu: ['none'],
    ied: ['none'],
    hmi: ['none'],
    'engineering-workstation': ['none'],
    'scada-server': ['none'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── Data Diode (unidirectional security gateway) ──────────────────────────────
  // A data diode enforces one-way information flow from OT to IT at the hardware
  // level (fiber optic with transmit-only laser). The IT side (historian) receives
  // data but cannot send replies back into OT. Represented on the canvas as a
  // connection that can only carry data from source to target.
  'data-diode': {
    historian: ['none'], // OT data → historian; no reverse path
    'application-server': ['none'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none']
  },

  // ── Wireless Access Point (industrial 802.11 / WirelessHART AP) ───────────────
  // WAPs in OT networks provide wireless coverage for WirelessHART sensor arrays,
  // mobile HMI tablets, and engineering laptops. All connections use 'none' (Layer 2
  // Ethernet bridging) — the WAP is transparent at the application layer.
  wap: {
    'iiot-sensor': ['none'], // wireless association
    hmi: ['none'], // mobile/tablet HMI
    'engineering-workstation': ['none'], // wireless laptop
    'enterprise-desktop': ['none'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none']
  },

  // ── Engineering Workstation — programs and configures PLCs / RTUs / IEDs ─────
  // Sits on the control-center LAN (Level 3). Uses Ethernet to PLCs for web IDE
  // access; RS-232 console cable for serial programming ports on legacy devices.
  'engineering-workstation': {
    plc: ['none'], // Ethernet to OpenPLC web / EtherNet/IP config
    rtu: ['none'], // Ethernet to RTU management interface
    ied: ['none'], // Ethernet to IED configuration tool
    'iec61850-ied': ['none', 'iec61850'], // MMS engineering client (e.g. libiec61850 tools)
    'ethernetip-adapter': ['none', 'ethernet-ip'], // EtherNet/IP config tool (e.g. RSLinx/RSLogix-style client)
    'enip-plc': ['none', 'ethernet-ip'], // Studio 5000 / RSLinx-style CIP client
    'profinet-device': ['none', 'profinet'], // PROFINET DCP config tool (e.g. Siemens PST-style station naming/IP tool)
    sensor: ['none', 'bacnet'], // BAS engineering client (e.g. bacpypes3 tools)
    'safety-plc': ['none'], // SIS engineering console (TriStation, Safety Builder)
    'dcs-controller': ['none'], // DCS engineering workstation (DeltaV Explorer, Experion)
    'legacy-plc': ['none'], // Ethernet to Siemens TIA Portal / Step 7
    'iec104-rtu': ['none'], // Ethernet to IEC 104 RTU configuration
    'iot-gateway': ['none'], // IoT gateway management web UI
    hmi: ['none'],
    historian: ['opc-ua', 'none'],
    'application-server': ['none'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── Application Server — SCADA / MES middleware (Level 3) ────────────────────
  'application-server': {
    historian: ['opc-ua', 'none'],
    'database-server': ['none'],
    hmi: ['none'],
    'engineering-workstation': ['none'],
    'domain-controller': ['none'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── Database Server — process / relational DB (Level 3/4) ────────────────────
  'database-server': {
    'application-server': ['none'],
    historian: ['none'],
    'domain-controller': ['none'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── Enterprise IT (Level 4) — Ethernet only; no ICS protocols ───────────────
  'domain-controller': {
    'enterprise-desktop': ['none'],
    'engineering-workstation': ['none'],
    'application-server': ['none'],
    'database-server': ['none'],
    'business-server': ['none'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none']
  },
  'enterprise-desktop': {
    'domain-controller': ['none'],
    'application-server': ['none'],
    'business-server': ['none'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none']
  },
  'web-server': {
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },
  'business-server': {
    'domain-controller': ['none'],
    'database-server': ['none'],
    switch: ['none'],
    router: ['none'],
    firewall: ['none']
  },
  'email-server': {
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },
  'internet-server': {
    switch: ['none'],
    router: ['none'],
    firewall: ['none'],
    'ids-ips': ['none']
  },

  // ── Infrastructure: Ethernet pass-through — no ICS application protocols ───
  firewall: {
    plc: ['none'],
    rtu: ['none'],
    ied: ['none'],
    'iec61850-ied': ['none'],
    'ethernetip-adapter': ['none'],
    'enip-plc': ['none'],
    'profinet-device': ['none'],
    'ip-camera': ['none'],
    'safety-plc': ['none'],
    'dcs-controller': ['none'],
    'legacy-plc': ['none'], // Phase 10
    'iec104-rtu': ['none'], // Phase 10
    'process-unit': ['none'], // Phase 11
    hmi: ['none'],
    historian: ['none'],
    'scada-server': ['none'],
    'application-server': ['none'],
    'database-server': ['none'],
    'engineering-workstation': ['none'],
    sensor: ['none'],
    'smart-controller': ['none'],
    'smart-sensor': ['none'],
    'iiot-sensor': ['none'],
    'iot-gateway': ['none'],
    'jump-server': ['none'],
    'data-diode': ['none'],
    wap: ['none'],
    firewall: ['none'],
    'ids-ips': ['none'],
    switch: ['none'],
    router: ['none'],
    'domain-controller': ['none'],
    'web-server': ['none'],
    'business-server': ['none'],
    'enterprise-desktop': ['none'],
    'email-server': ['none'],
    'internet-server': ['none'],
    'dns-server': ['none'], // Phase 12
    'attack-machine': ['none']
  },
  'ids-ips': {
    plc: ['none'],
    rtu: ['none'],
    ied: ['none'],
    'iec61850-ied': ['none'],
    'ethernetip-adapter': ['none'],
    'enip-plc': ['none'],
    'profinet-device': ['none'],
    'ip-camera': ['none'],
    'safety-plc': ['none'],
    'dcs-controller': ['none'],
    'legacy-plc': ['none'], // Phase 10
    'iec104-rtu': ['none'], // Phase 10
    'process-unit': ['none'], // Phase 11
    hmi: ['none'],
    historian: ['none'],
    'scada-server': ['none'],
    'application-server': ['none'],
    'database-server': ['none'],
    'engineering-workstation': ['none'],
    sensor: ['none'],
    'smart-controller': ['none'],
    'smart-sensor': ['none'],
    'iiot-sensor': ['none'],
    'iot-gateway': ['none'],
    'jump-server': ['none'],
    'data-diode': ['none'],
    wap: ['none'],
    firewall: ['none'],
    'ids-ips': ['none'],
    switch: ['none'],
    router: ['none'],
    'domain-controller': ['none'],
    'web-server': ['none'],
    'business-server': ['none'],
    'enterprise-desktop': ['none'],
    'email-server': ['none'],
    'internet-server': ['none'],
    'dns-server': ['none'], // Phase 12
    'attack-machine': ['none']
  },
  switch: {
    plc: ['none'],
    rtu: ['none'],
    ied: ['none'],
    'iec61850-ied': ['none'],
    'ethernetip-adapter': ['none'],
    'enip-plc': ['none'],
    'profinet-device': ['none'],
    'ip-camera': ['none'],
    'safety-plc': ['none'],
    'dcs-controller': ['none'],
    'legacy-plc': ['none'], // Phase 10
    'iec104-rtu': ['none'], // Phase 10
    'process-unit': ['none'], // Phase 11
    hmi: ['none'],
    historian: ['none'],
    'scada-server': ['none'],
    'application-server': ['none'],
    'database-server': ['none'],
    'engineering-workstation': ['none'],
    sensor: ['none'],
    'smart-controller': ['none'],
    'smart-sensor': ['none'],
    'iiot-sensor': ['none'],
    'iot-gateway': ['none'],
    'jump-server': ['none'],
    'data-diode': ['none'],
    wap: ['none'],
    firewall: ['none'],
    'ids-ips': ['none'],
    switch: ['none'],
    router: ['none'],
    'domain-controller': ['none'],
    'web-server': ['none'],
    'business-server': ['none'],
    'enterprise-desktop': ['none'],
    'email-server': ['none'],
    'internet-server': ['none'],
    'dns-server': ['none'], // Phase 12
    'attack-machine': ['none']
  },
  router: {
    plc: ['none'],
    rtu: ['none'],
    ied: ['none'],
    'iec61850-ied': ['none'],
    'ethernetip-adapter': ['none'],
    'enip-plc': ['none'],
    'profinet-device': ['none'],
    'ip-camera': ['none'],
    'safety-plc': ['none'],
    'dcs-controller': ['none'],
    'legacy-plc': ['none'], // Phase 10
    'iec104-rtu': ['none'], // Phase 10
    'process-unit': ['none'], // Phase 11
    hmi: ['none'],
    historian: ['none'],
    'scada-server': ['none'],
    'application-server': ['none'],
    'database-server': ['none'],
    'engineering-workstation': ['none'],
    sensor: ['none'],
    'smart-controller': ['none'],
    'smart-sensor': ['none'],
    'iiot-sensor': ['none'],
    'iot-gateway': ['none'],
    'jump-server': ['none'],
    'data-diode': ['none'],
    wap: ['none'],
    firewall: ['none'],
    'ids-ips': ['none'],
    switch: ['none'],
    router: ['none'],
    'domain-controller': ['none'],
    'web-server': ['none'],
    'business-server': ['none'],
    'enterprise-desktop': ['none'],
    'email-server': ['none'],
    'internet-server': ['none'],
    'dns-server': ['none'], // Phase 12
    'attack-machine': ['none']
  },

  // ── Attack machine — can attempt any protocol (External zone red team) ──────
  // All protocols listed because an attacker is not constrained by operational
  // intent. Students see this device can reach anything — that's the lesson.
  // Phase 10: s7comm and iec-104 added to enable Siemens S7 and IEC 104 attacks.
  'attack-machine': {
    plc: [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    rtu: [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    ied: [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    // MMS read/write attacks (unauthenticated GetDataValues/SetDataValues) against
    // the real IEC 61850 IED — analogous to the GOOSE/IEC 104 breaker-trip attacks
    // used in the Ukraine grid incidents.
    'iec61850-ied': ['iec61850', 'none'],
    // Unauthenticated Set_Attribute_Single write to the adapter's Output Assembly —
    // the same write path a legitimate scanning PLC uses, but from an unauthorized host.
    'ethernetip-adapter': ['ethernet-ip', 'none'],
    // CIP Write Tag / List Identity against Logix-style endpoints (cpppo/scada).
    'enip-plc': ['ethernet-ip', 'none'],
    // Unauthenticated DCP Set — rename the station or reassign its IP with zero
    // credentials, the same way a legitimate engineering tool would configure it.
    'profinet-device': ['profinet', 'none'],
    // Weak/default SSH credentials — classic IoT/camera compromise (Mirai-style),
    // the initial foothold for a pivot into whatever zone the camera is also attached to.
    'ip-camera': ['none'],
    // TRITON/TRISIS attack vector: TriStation protocol injection into SIS — Schneider Triconex, 2017
    'safety-plc': ['modbus-tcp', 'modbus-rtu', 'ethernet-ip', 'opc-ua', 'none'],
    // DCS attacks: OPC-UA credential attacks, Modbus setpoint manipulation
    'dcs-controller': ['modbus-tcp', 'modbus-rtu', 'opc-ua', 'none'],
    // Siemens S7 attack surface: s7-enumerate (Nmap), siemens_simatic_manager (Metasploit)
    'legacy-plc': [
      's7comm',
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    // IEC 104 attack surface: General Interrogation spoofing, command injection
    'iec104-rtu': [
      'iec-104',
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    // Process unit attack surface: Modbus coil injection (CO3=ESD), setpoint tampering
    'process-unit': [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    hmi: [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    historian: [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    // SCADA server: highest-value target — poll manipulation, display spoofing
    'scada-server': ['modbus-tcp', 'modbus-rtu', 'dnp3', 'opc-ua', 'iec61850', 'none'],
    sensor: [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    // Includes former actuator/pump/valve/vfd — Stuxnet-style Modbus/EtherNet-IP setpoint manipulation
    'smart-controller': [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    // Includes former flow-meter/pressure-transmitter/level-transmitter/analyzer/pmu —
    // GPS spoofing + DNP3 injection attacks apply to the former pmu kind
    'smart-sensor': [
      'modbus-tcp',
      'modbus-rtu',
      'dnp3',
      'opc-ua',
      'bacnet',
      'ethernet-ip',
      'iec61850',
      'none'
    ],
    // IIoT attack surface: MQTT broker compromise, spoofed sensor readings
    'iiot-sensor': ['mqtt', 'none'],
    'iot-gateway': ['mqtt', 'opc-ua', 'modbus-tcp', 'none'],
    // Plant DMZ attack surface: jump server exploitation, data diode bypass attempt
    'jump-server': ['none'],
    'data-diode': ['none'],
    wap: ['none'],
    // Control center targets — lateral movement from enterprise into OT
    'engineering-workstation': ['none'],
    'application-server': ['none'],
    'database-server': ['none'],
    // Enterprise zone targets — lateral movement and credential attacks
    'domain-controller': ['none'],
    'web-server': ['none'],
    'business-server': ['none'],
    'enterprise-desktop': ['none'],
    // Internet DMZ targets — OSINT, phishing recon, banner grabbing
    'email-server': ['none'],
    'internet-server': ['none'],
    // Phase 12: DNS reconnaissance — dig/nslookup/fierce zone-transfer attempts
    'dns-server': ['none'],
    firewall: ['none'],
    'ids-ips': ['none'],
    switch: ['none'],
    router: ['none']
  }
}

/**
 * Returns the set of protocols that the given source device category can ever use,
 * across all possible target types. Used to filter the context menu so students
 * only see protocols that are meaningful for the device they right-clicked.
 *
 * @example
 * getSourceProtocols('sensor')
 * // → Set { 'modbus-tcp', 'modbus-rtu', 'modbus-ascii', 'ethernet-ip', 'dnp3' }
 */
export function getSourceProtocols(source: DeviceCategory): Set<Protocol> {
  const targets = VALID_CONNECTIONS[source] ?? {}
  const result = new Set<Protocol>()
  for (const protocols of Object.values(targets)) {
    for (const p of protocols) result.add(p)
  }
  return result
}

/**
 * Returns the list of protocols valid for a specific source→target device pair.
 * Returns an empty array when no valid protocol exists between the two categories.
 *
 * @param source - Category of the initiating device.
 * @param target - Category of the destination device.
 */
export function getValidProtocols(source: DeviceCategory, target: DeviceCategory): Protocol[] {
  return VALID_CONNECTIONS[source]?.[target] ?? []
}

/**
 * Returns true if `protocol` is a valid choice for the given source→target pair.
 *
 * @param source   - Category of the initiating device.
 * @param target   - Category of the destination device.
 * @param protocol - Protocol selected from the connection context menu.
 */
export function isConnectionValid(
  source: DeviceCategory,
  target: DeviceCategory,
  protocol: Protocol
): boolean {
  return getValidProtocols(source, target).includes(protocol)
}

/** Human-readable names used in rejection tooltip messages. */
const CATEGORY_NAMES: Record<DeviceCategory, string> = {
  plc: 'PLC',
  rtu: 'RTU',
  ied: 'IED',
  'iec61850-ied': 'IEC 61850 IED',
  'ethernetip-adapter': 'EtherNet/IP Adapter',
  'profinet-device': 'PROFINET Device',
  'safety-plc': 'Safety PLC / SIS',
  'dcs-controller': 'DCS Controller',
  'legacy-plc': 'Siemens S7 PLC', // Phase 10
  'enip-plc': 'ControlLogix 1756-L61',
  'iec104-rtu': 'IEC 104 RTU', // Phase 10
  'process-unit': 'Process Unit', // Phase 11
  sensor: 'Sensor',
  'iiot-sensor': 'IIoT Sensor',
  'iot-gateway': 'IoT Gateway',
  'smart-sensor': 'Smart Sensor',
  'smart-controller': 'Smart Controller',
  hmi: 'HMI',
  historian: 'Historian',
  'scada-server': 'SCADA Server',
  'application-server': 'Application Server',
  'database-server': 'Database Server',
  'engineering-workstation': 'Engineering Workstation',
  firewall: 'Firewall',
  'ids-ips': 'IDS/IPS',
  switch: 'Switch',
  router: 'Router',
  'jump-server': 'Jump Server',
  'data-diode': 'Data Diode',
  wap: 'Wireless AP',
  'domain-controller': 'Domain Controller',
  'web-server': 'Web Server',
  'business-server': 'Business Server',
  'enterprise-desktop': 'Enterprise Desktop',
  'email-server': 'Email Server',
  'internet-server': 'Internet Server',
  'dns-server': 'DNS Server', // Phase 12
  'ip-camera': 'IP Camera',
  'attack-machine': 'Attack Machine'
}

// ── Cable type validation ─────────────────────────────────────────────────────
//
// Physical cable validation uses a symmetric capability model: each device category
// declares the set of cable types it can physically terminate. A cable is valid
// between two devices only if BOTH appear in that cable's supported set.
//
// Additionally, PROTOCOL_VALID_CABLES below enforces protocol-medium consistency
// so students cannot assign Modbus TCP (an Ethernet protocol) to an RS-485 cable.
//
// Educational rationale per medium:
//   RS-485  — multi-drop serial field bus; PLC/RTU serial ports and field instruments
//   RS-232  — point-to-point console port; engineering workstations and PLC/RTU console jacks
//   Cat5e   — 100 Mbps Ethernet; OT field networks, entry-level IT
//   Cat6    — 1 Gbps Ethernet; control center, enterprise desktop
//   Cat6a   — 10 Gbps Ethernet; data center spine links, high-throughput servers
//   MMF     — multi-mode fiber; in-building backbone where copper won't do
//   SMF     — single-mode fiber; inter-building and inter-zone long runs
//   Wi-Fi   — 802.11 a/b/g/n/ac/ax; WirelessHART (ISA100.11a); mobile HMI, wireless field devices
//   SATA    — Serial ATA; direct-attached storage for historians, servers, database devices
//   AC      — mains power; any device that plugs into the wall
//   DC      — 24 VDC loop power; field instruments sourced from PLC/RTU DIN rail PSU
//
// Sources: TIA-568 (structured cabling), IEC 61158 (field bus), ISA-12 (hazardous area wiring),
//          IEC 62591 (WirelessHART), ISA-100.11a (wireless industrial)

/**
 * Cable media types physically supportable by each device category.
 * Intersection of two devices' capability sets gives valid cables between them.
 */
const DEVICE_CABLE_CAPABILITIES: Record<DeviceCategory, Set<CableType>> = {
  // ── PLCs and RTUs — serial field bus port + Ethernet management + DIN rail PSU ──────
  plc: new Set(['rs485', 'rs232', 'cat5e', 'cat6', 'ac']),
  rtu: new Set(['rs485', 'rs232', 'cat5e', 'cat6', 'ac']),
  // IEDs: Ethernet only (IEC 61850 GOOSE runs on Cat5e/fiber, no serial field bus)
  ied: new Set(['cat5e', 'cat6', 'mmf', 'smf', 'ac']),
  'iec61850-ied': new Set(['cat5e', 'cat6', 'mmf', 'smf', 'ac']),
  // EtherNet/IP remote I/O adapter: standard Ethernet only (wireless EtherNet/IP is
  // not common in OT deployments) + mains power for the field enclosure/DIN rail.
  'ethernetip-adapter': new Set(['cat5e', 'cat6', 'cat6a', 'mmf', 'smf', 'ac']),
  // PROFINET IO device: standard Ethernet only — RT cyclic timing requirements
  // (even for the DCP-only scope here) make wireless media unrealistic in real
  // deployments — + mains power for the field enclosure/DIN rail.
  'profinet-device': new Set(['cat5e', 'cat6', 'cat6a', 'mmf', 'smf', 'ac']),
  // Safety PLC: same port set as PLC; isolated physical network segment per ISA-84
  'safety-plc': new Set(['rs485', 'rs232', 'cat5e', 'cat6', 'ac']),
  // DCS Controller: larger system, fiber uplinks to DCS node bus are common
  'dcs-controller': new Set(['rs485', 'rs232', 'cat5e', 'cat6', 'mmf', 'smf', 'ac']),
  'legacy-plc': new Set(['rs485', 'rs232', 'cat5e', 'cat6', 'ac']), // Siemens S7 — same ports
  'enip-plc': new Set(['cat5e', 'cat6', 'cat6a', 'mmf', 'smf', 'ac']), // Logix CIP — Ethernet only
  'iec104-rtu': new Set(['rs485', 'rs232', 'cat5e', 'cat6', 'ac']), // IEC 104 RTU — same ports
  'process-unit': new Set(['cat5e', 'cat6', 'ac']), // process sim panel — Ethernet + mains

  // ── Field instruments — RS-485 (serial Modbus RTU) or Cat5e (Ethernet Modbus TCP) ──
  // Smart sensors with WirelessHART/ISA100 also support Wi-Fi for wireless polling.
  // DC loop power (4-20 mA / HART) is the standard 24 VDC two-wire instrument supply.
  sensor: new Set(['rs485', 'cat5e', 'wifi', 'dc']),
  'iiot-sensor': new Set(['wifi', 'dc']), // wireless only; battery/loop powered
  'iot-gateway': new Set(['rs485', 'cat5e', 'cat6', 'wifi', 'ac']), // bridges serial→Ethernet
  // Union of all 8 kinds' wiring options (temperature/gas/flow/pressure/level/analyzer:
  // 4-20 mA loop, RS-485, Ethernet; vibration/pmu add Wi-Fi/fiber for wireless/GPS-timed links).
  'smart-sensor': new Set(['rs485', 'cat5e', 'wifi', 'dc']),
  // VFD/pump/valve/actuator wiring: RS-485 (Modbus RTU) + Cat5e (EtherNet/IP) + AC from MCC.
  'smart-controller': new Set(['rs485', 'cat5e', 'wifi', 'dc', 'ac']),

  // ── Control center (L3) — Ethernet; EWS also has RS-232 console port ─────────────
  // HMI: Cat5e/Cat6 wired; modern panel PCs may also have Wi-Fi for roaming tablets.
  hmi: new Set(['cat5e', 'cat6', 'wifi', 'ac']),
  // Historian: Ethernet + SATA for direct-attached storage (time-series data volumes).
  historian: new Set(['cat5e', 'cat6', 'cat6a', 'sata', 'ac']),
  // SCADA Server: server-class hardware; fiber uplinks to OT network
  'scada-server': new Set(['cat5e', 'cat6', 'cat6a', 'smf', 'mmf', 'sata', 'ac']),
  'application-server': new Set(['cat6', 'cat6a', 'smf', 'mmf', 'sata', 'ac']),
  'database-server': new Set(['cat6', 'cat6a', 'smf', 'mmf', 'sata', 'ac']),
  // Engineering workstation: RS-232 for PLC serial console; Wi-Fi for wireless laptop
  'engineering-workstation': new Set(['rs232', 'cat5e', 'cat6', 'wifi', 'ac']),

  // ── Plant DMZ (L3.5) — all Ethernet and fiber speeds ─────────────────────────────
  firewall: new Set(['cat5e', 'cat6', 'cat6a', 'smf', 'mmf', 'ac']),
  'ids-ips': new Set(['cat5e', 'cat6', 'cat6a', 'smf', 'mmf', 'ac']),
  // Switch: includes Wi-Fi for wireless access point / controller functionality
  switch: new Set(['cat5e', 'cat6', 'cat6a', 'smf', 'mmf', 'wifi', 'ac']),
  router: new Set(['cat5e', 'cat6', 'cat6a', 'smf', 'mmf', 'wifi', 'ac']),
  // Jump server: hardened server hardware — Ethernet + fiber + SATA
  'jump-server': new Set(['cat5e', 'cat6', 'cat6a', 'smf', 'mmf', 'sata', 'ac']),
  // Data diode: fiber preferred (optical isolation), Cat6 also supported
  'data-diode': new Set(['cat5e', 'cat6', 'mmf', 'smf', 'ac']),
  // WAP: wired Ethernet uplink + WiFi radio antenna
  wap: new Set(['cat5e', 'cat6', 'wifi', 'ac']),

  // ── Enterprise (L4) — Gbps Ethernet; fiber uplinks; SATA storage ─────────────────
  'domain-controller': new Set(['cat6', 'cat6a', 'smf', 'mmf', 'sata', 'ac']),
  'web-server': new Set(['cat6', 'cat6a', 'smf', 'mmf', 'sata', 'ac']),
  'business-server': new Set(['cat6', 'cat6a', 'sata', 'ac']),
  'enterprise-desktop': new Set(['cat6', 'cat6a', 'wifi', 'ac']),

  // ── Internet DMZ (L5) — Gbps Ethernet; long-haul fiber; SATA storage ─────────────
  'email-server': new Set(['cat6', 'cat6a', 'smf', 'sata', 'ac']),
  'internet-server': new Set(['cat6', 'cat6a', 'smf', 'sata', 'ac']),
  'dns-server': new Set(['cat6', 'cat6a', 'smf', 'sata', 'ac']),
  // IP camera: PoE Ethernet is standard; many cheaper/consumer models are Wi-Fi only.
  'ip-camera': new Set(['cat5e', 'cat6', 'wifi', 'ac']),

  // ── Attack machine — all cable types (adversary simulates any physical access) ─────
  'attack-machine': new Set([
    'rs232',
    'rs485',
    'cat5e',
    'cat6',
    'cat6a',
    'smf',
    'mmf',
    'wifi',
    'sata',
    'ac',
    'dc'
  ])
}

// ── Protocol ↔ Cable medium compatibility ────────────────────────────────────
//
// Not every cable can carry every protocol. This map enforces physical-layer
// consistency so students cannot, for example, assign Modbus TCP (an Ethernet
// application protocol) to an RS-485 cable (a serial field-bus medium).
//
// Key rules:
//   Modbus TCP / OPC-UA / EtherNet/IP / IEC 61850 / S7comm / IEC-104 / BACnet
//     → Ethernet (Cat5e/6/6a), Fiber (SMF/MMF), or Wi-Fi only
//   Modbus RTU / Modbus ASCII
//     → RS-485 or RS-232 only (serial byte-stream protocols)
//   DNP3
//     → serial (RS-485/RS-232) OR Ethernet/Fiber/Wi-Fi (DNP3 runs on both)
//   'none' (raw Ethernet / unspecified)
//     → any medium (represents an L2 Ethernet frame with no application-layer tag)
//
// Sources: Modbus spec v1.1b3, DNP3 Subset Definition, IEC 62443-3-3
const PROTOCOL_VALID_CABLES: Partial<Record<Protocol, ReadonlySet<CableType>>> = {
  'modbus-tcp': new Set<CableType>(['cat5e', 'cat6', 'cat6a', 'smf', 'mmf', 'wifi']),
  'modbus-rtu': new Set<CableType>(['rs485', 'rs232']),
  'modbus-ascii': new Set<CableType>(['rs485', 'rs232']),
  // DNP3 runs on serial AND IP transport (DNP3 over TCP/UDP in SCADA WAN links)
  dnp3: new Set<CableType>(['rs485', 'rs232', 'cat5e', 'cat6', 'cat6a', 'smf', 'mmf', 'wifi']),
  'opc-ua': new Set<CableType>(['cat5e', 'cat6', 'cat6a', 'smf', 'mmf', 'wifi']),
  bacnet: new Set<CableType>(['cat5e', 'cat6', 'cat6a', 'smf', 'mmf', 'wifi']),
  // EtherNet/IP uses standard Ethernet frames; wireless EtherNet/IP not common in OT
  'ethernet-ip': new Set<CableType>(['cat5e', 'cat6', 'cat6a', 'smf', 'mmf']),
  // IEC 61850 GOOSE/MMS is Ethernet only — time-critical GOOSE requires deterministic L2
  iec61850: new Set<CableType>(['cat5e', 'cat6', 'cat6a', 'smf', 'mmf']),
  // S7comm is ISO-on-TCP (port 102); runs on Ethernet only
  s7comm: new Set<CableType>(['cat5e', 'cat6', 'cat6a', 'smf', 'mmf']),
  // IEC 104 is TCP/IP transport for IEC 101 telecontrol; WAN links may use fiber or WiFi
  'iec-104': new Set<CableType>(['cat5e', 'cat6', 'cat6a', 'smf', 'mmf', 'wifi']),
  // MQTT is TCP/IP — runs over Ethernet and WiFi; not on RS-485/RS-232 serial
  mqtt: new Set<CableType>(['wifi', 'cat5e', 'cat6', 'cat6a', 'smf', 'mmf']),
  // 'none' = raw Ethernet / untagged — compatible with any medium
  none: undefined
}

/**
 * Returns the set of cable types the given device category can physically terminate.
 * Used to filter the cable section of the connection context menu.
 *
 * @example
 * getSourceCables('sensor')
 * // → Set { 'rs485', 'cat5e', 'dc' }
 */
export function getSourceCables(source: DeviceCategory): Set<CableType> {
  return DEVICE_CABLE_CAPABILITIES[source] ?? new Set()
}

/**
 * Returns the list of cable types valid for a specific source→target device pair.
 * A cable is valid only when BOTH device categories can terminate that media type.
 * Returns an empty array when no compatible cable exists.
 *
 * @param source - Category of the initiating device.
 * @param target - Category of the destination device.
 */
export function getValidCables(source: DeviceCategory, target: DeviceCategory): CableType[] {
  const sCables = DEVICE_CABLE_CAPABILITIES[source] ?? new Set<CableType>()
  const tCables = DEVICE_CABLE_CAPABILITIES[target] ?? new Set<CableType>()
  const result: CableType[] = []
  for (const cable of sCables) {
    if (tCables.has(cable)) result.push(cable)
  }
  return result
}

/**
 * Returns true if `cable` is a valid physical medium for the given source→target pair.
 *
 * @param source - Category of the initiating device.
 * @param target - Category of the destination device.
 * @param cable  - Cable type selected from the connection context menu.
 */
export function isCableValid(
  source: DeviceCategory,
  target: DeviceCategory,
  cable: CableType
): boolean {
  const sCables = DEVICE_CABLE_CAPABILITIES[source] ?? new Set<CableType>()
  const tCables = DEVICE_CABLE_CAPABILITIES[target] ?? new Set<CableType>()
  return sCables.has(cable) && tCables.has(cable)
}

/**
 * Returns true when the selected protocol can physically run over the chosen cable medium.
 *
 * For example, Modbus TCP (an Ethernet application protocol) cannot run over RS-485 —
 * that pairing is rejected even if both devices support RS-485. When `protocol` is 'none'
 * (untagged Ethernet), any cable is accepted because 'none' represents a raw L2 frame.
 *
 * @param protocol - Application protocol selected from the connection context menu.
 * @param cable    - Physical cable type selected from the same menu.
 */
export function isProtocolCableCompatible(protocol: Protocol, cable: CableType): boolean {
  const validCables = PROTOCOL_VALID_CABLES[protocol]
  // 'none' (undefined entry) accepts every medium
  if (validCables === undefined) return true
  return validCables.has(cable)
}

/**
 * Human-readable cable type names for rejection messages.
 */
const CABLE_TYPE_NAMES: Record<CableType, string> = {
  cat5e: 'Cat5e Ethernet',
  cat6: 'Cat6 Ethernet',
  cat6a: 'Cat6a Ethernet (10G)',
  smf: 'Single-Mode Fiber',
  mmf: 'Multi-Mode Fiber',
  wifi: 'Wi-Fi 802.11',
  rs232: 'RS-232 Serial',
  rs485: 'RS-485 Serial',
  sata: 'SATA Storage',
  ac: 'AC Power',
  dc: 'DC Power'
}

/**
 * Returns an educational rejection message explaining why the selected cable type
 * is incompatible with the given device pair, or why the selected cable cannot carry
 * the chosen application protocol.
 *
 * Four rejection cases (checked in order):
 *   1. Source device has no port for this cable medium.
 *   2. Target device has no port for this cable medium.
 *   3. The two devices share no compatible cable at all.
 *   4. The cable is a valid medium between these devices, but the protocol
 *      selected elsewhere in the connection menu cannot run over it (e.g.,
 *      Modbus TCP over RS-485, or EtherNet/IP over Wi-Fi).
 *
 * @param source   - Category of the initiating device.
 * @param target   - Category of the destination device.
 * @param cable    - Cable type that was rejected.
 * @param protocol - Optional: the protocol chosen for this connection. When
 *                   provided, a fifth check verifies protocol-medium compatibility.
 */
export function getCableRejectionReason(
  source: DeviceCategory,
  target: DeviceCategory,
  cable: CableType,
  protocol?: Protocol
): string {
  const validCables = getValidCables(source, target)
  const src = CATEGORY_NAMES[source]
  const tgt = CATEGORY_NAMES[target]
  const cableName = CABLE_TYPE_NAMES[cable]

  if (!DEVICE_CABLE_CAPABILITIES[source]?.has(cable)) {
    return `${src} has no ${cableName} port. Valid cables for this device: ${
      Array.from(DEVICE_CABLE_CAPABILITIES[source] ?? [])
        .map(c => CABLE_TYPE_NAMES[c])
        .join(', ') || 'none'
    }`
  }
  if (!DEVICE_CABLE_CAPABILITIES[target]?.has(cable)) {
    return `${tgt} has no ${cableName} port. Valid cables for this device: ${
      Array.from(DEVICE_CABLE_CAPABILITIES[target] ?? [])
        .map(c => CABLE_TYPE_NAMES[c])
        .join(', ') || 'none'
    }`
  }
  if (validCables.length === 0) {
    return `${src} and ${tgt} share no compatible cable types.`
  }
  // Protocol-medium mismatch: cable is physically valid between the two devices,
  // but the chosen application protocol cannot run over this physical layer.
  if (protocol && protocol !== 'none' && !isProtocolCableCompatible(protocol, cable)) {
    const allowedCables = PROTOCOL_VALID_CABLES[protocol]
    const allowedNames = allowedCables
      ? Array.from(allowedCables)
          .map(c => CABLE_TYPE_NAMES[c])
          .join(', ')
      : 'any'
    return `${protocol} cannot run over ${cableName}. This is an Ethernet/IP protocol — valid media: ${allowedNames}.`
  }
  return `${src} → ${tgt}: ${cableName} is not compatible. Valid cables: ${validCables
    .map(c => CABLE_TYPE_NAMES[c])
    .join(', ')}`
}

/**
 * Returns an educational rejection message explaining why an attempted connection
 * is invalid according to the Purdue Reference Model.
 *
 * Three rejection cases:
 *   1. Completely incompatible pair — no protocol can link these two categories.
 *   2. Valid pair, wrong protocol — the devices CAN be linked, but not this way.
 *   3. Fallback message (should not occur if matrix is complete).
 *
 * @param source   - Category of the initiating (source) device.
 * @param target   - Category of the destination (target) device.
 * @param protocol - Protocol the student selected from the context menu.
 * @returns Human-readable explanation shown in the canvas tooltip.
 *
 * @example
 * getRejectionReason('sensor', 'hmi', 'modbus-tcp')
 * // → 'Sensor → HMI: no valid connection in the Purdue model.
 * //    Field devices only connect to PLCs, RTUs, or IEDs.'
 */
export function getRejectionReason(
  source: DeviceCategory,
  target: DeviceCategory,
  protocol: Protocol
): string {
  const validProtocols = getValidProtocols(source, target)
  const src = CATEGORY_NAMES[source]
  const tgt = CATEGORY_NAMES[target]

  if (validProtocols.length === 0) {
    // No protocol can link these two device categories in the Purdue model
    return `${src} → ${tgt}: incompatible in the Purdue model. No valid protocol exists between these device types.`
  }

  if (!validProtocols.includes(protocol)) {
    // The pair is compatible, but not with the chosen protocol
    const supported = validProtocols.join(', ')
    return `${src} → ${tgt}: ${protocol} is not supported here. Valid protocols: ${supported}`
  }

  // Fallback (matrix should prevent this, but guard defensively)
  return `${src} → ${tgt}: connection blocked`
}

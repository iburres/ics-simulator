#!/usr/bin/env python3
"""
server.py — BACnet/IP device server (raw UDP — no bacpypes3 required).

Implements a minimal BACnet/IP outstation using asyncio UDP sockets and
hand-rolled BVLC/NPCI/APDU encoding. Responds to ReadProperty and
WriteProperty requests for objectList, presentValue, and objectName.

The bacpypes3 high-level API changed its NormalApplication constructor
signature across minor versions (string address → IPv4Address object,
direct instantiation → async context manager). Raw UDP removes the
dependency entirely so the server works regardless of the bacpypes3
version installed in the container.

Object model is selected by BACNET_KIND (see KIND_DEFINITIONS below):

    generic     — the original Lab_02 protocol-survey model: Temperature,
                  Pressure, FlowRate, TankLevel (analog inputs) + PumpRunning,
                  ValveOpen (binary inputs). Read-only, kept unchanged for
                  backward compatibility with scenarios saved before the
                  building-automation kinds existed.
    ahu         — Air Handling Unit: supply/return air temperature (AI),
                  a writable supply-air setpoint (AV), and a writable fan
                  command (BO) that drives a fan-status readback (BI).
    vav         — Variable Air Volume box: zone temperature + airflow (AI),
                  a writable zone setpoint (AV), and a writable damper
                  position (AO).
    chiller     — chilled-water supply/return temperature (AI), a writable
                  setpoint (AV), and a writable chiller command (BO) that
                  drives a status readback (BI).
    zone-sensor — read-only room sensor: temperature, humidity, CO2 (AI)
                  and occupancy (BI). No writable points.

Environment variables (all have defaults):
    DEVICE_ID              — string label used in logging
    DEVICE_CATEGORY        — device category for traceability
    BACNET_DEVICE_INSTANCE — BACnet device instance number
    BACNET_PORT            — UDP port (default 47808)
    BACNET_KIND            — equipment model to serve (default "generic")

Protocol reference: ASHRAE 135-2020 (BACnet)
"""

import asyncio
import logging
import os
import random
import struct

# ── Configuration ─────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ics-bacnet")

DEVICE_ID       = os.getenv("DEVICE_ID", "bacnet-1")
CATEGORY        = os.getenv("DEVICE_CATEGORY", "sensor")
DEVICE_INSTANCE = int(os.getenv("BACNET_DEVICE_INSTANCE", "1001"))
PORT            = int(os.getenv("BACNET_PORT", "47808"))
KIND            = os.getenv("BACNET_KIND", "generic")

# ── BACnet object type codes (ASHRAE 135 Table 12-1) ─────────────────────────
OBJ_ANALOG_INPUT  = 0
OBJ_ANALOG_OUTPUT = 1
OBJ_ANALOG_VALUE  = 2
OBJ_BINARY_INPUT  = 3
OBJ_BINARY_OUTPUT = 4
OBJ_BINARY_VALUE  = 5
OBJ_DEVICE        = 8

# ── BACnet property identifier codes (ASHRAE 135 Table 12-2) ─────────────────
PROP_OBJECT_LIST   = 76
PROP_OBJECT_NAME   = 77
PROP_PRESENT_VALUE = 85

# ── BACnet application tag numbers ───────────────────────────────────────────
TAG_REAL        = 4
TAG_CHAR_STRING = 7
TAG_ENUMERATED  = 9
TAG_OBJECT_ID   = 12

# ── Per-kind object definitions ───────────────────────────────────────────────
#
# Each kind provides five lists plus a feedback map:
#   analog_inputs:  (instance, name, initial_value, drift_magnitude) — read-only,
#                    drifts every simulation tick like a real live measurement.
#   analog_values:  (instance, name, initial_value) — writable setpoints; do not
#                    drift on their own (an operator/attacker sets them directly).
#   analog_outputs: (instance, name, initial_value) — writable actuator positions
#                    (e.g. a damper %); same non-drifting behavior as analog_values.
#   binary_inputs:  (instance, name, initial_value) — read-only status points.
#   binary_outputs: (instance, name, initial_value) — writable commands.
#   feedback: {(OBJ_BINARY_OUTPUT, instance): (OBJ_BINARY_INPUT, instance)} —
#             writing a binary output also copies the same value onto the
#             linked binary input, so e.g. commanding FanCommand OFF is
#             observable by reading FanStatus, without a full priority-array
#             simulation (this project's control points elsewhere — e.g. the
#             IEC 61850 XCBR1 breaker — use the same "direct write reflected
#             in a status point" simplification instead of select-before-operate).
KIND_DEFINITIONS: dict[str, dict] = {
    "generic": {
        "analog_inputs": [
            (1, "Temperature", 25.0, 2.0),
            (2, "Pressure", 101.3, 1.5),
            (3, "FlowRate", 15.0, 3.0),
            (4, "TankLevel", 500.0, 10.0),
        ],
        "analog_values": [],
        "analog_outputs": [],
        "binary_inputs": [
            (1, "PumpRunning", True),
            (2, "ValveOpen", True),
        ],
        "binary_outputs": [],
        "feedback": {},
    },
    "ahu": {
        "analog_inputs": [
            (1, "SupplyAirTemp", 13.0, 0.5),
            (2, "ReturnAirTemp", 22.0, 0.5),
        ],
        "analog_values": [
            (1, "SupplyAirTempSetpoint", 13.0),
        ],
        "analog_outputs": [],
        "binary_inputs": [
            (1, "FanStatus", True),
        ],
        "binary_outputs": [
            (1, "FanCommand", True),
        ],
        "feedback": {(OBJ_BINARY_OUTPUT, 1): (OBJ_BINARY_INPUT, 1)},
    },
    "vav": {
        "analog_inputs": [
            (1, "ZoneTemp", 22.0, 0.3),
            (2, "Airflow", 400.0, 20.0),
        ],
        "analog_values": [
            (1, "ZoneTempSetpoint", 22.0),
        ],
        "analog_outputs": [
            (1, "DamperPosition", 50.0),
        ],
        "binary_inputs": [],
        "binary_outputs": [],
        "feedback": {},
    },
    "chiller": {
        "analog_inputs": [
            (1, "ChilledWaterSupplyTemp", 6.7, 0.3),
            (2, "ChilledWaterReturnTemp", 12.2, 0.3),
        ],
        "analog_values": [
            (1, "ChilledWaterSetpoint", 6.7),
        ],
        "analog_outputs": [],
        "binary_inputs": [
            (1, "ChillerStatus", True),
        ],
        "binary_outputs": [
            (1, "ChillerCommand", True),
        ],
        "feedback": {(OBJ_BINARY_OUTPUT, 1): (OBJ_BINARY_INPUT, 1)},
    },
    "zone-sensor": {
        "analog_inputs": [
            (1, "ZoneTemp", 22.0, 0.3),
            (2, "Humidity", 45.0, 2.0),
            (3, "CO2", 600.0, 30.0),
        ],
        "analog_values": [],
        "analog_outputs": [],
        "binary_inputs": [
            (1, "Occupied", True),
        ],
        "binary_outputs": [],
        "feedback": {},
    },
}

# ── In-memory object store ────────────────────────────────────────────────────
# Key: (obj_type, instance) — Value: dict with name, value, value_type, drift, writable
_objects: dict[tuple[int, int], dict] = {}
_feedback: dict[tuple[int, int], tuple[int, int]] = {}


def _init_objects() -> None:
    """Populate the in-memory object store from KIND_DEFINITIONS[KIND]."""
    kind_def = KIND_DEFINITIONS.get(KIND, KIND_DEFINITIONS["generic"])

    obj_list = [(OBJ_DEVICE, DEVICE_INSTANCE)]

    for inst, name, initial, drift in kind_def["analog_inputs"]:
        _objects[(OBJ_ANALOG_INPUT, inst)] = {
            "name": name, "value": initial, "value_type": "real",
            "drift": drift, "writable": False,
        }
        obj_list.append((OBJ_ANALOG_INPUT, inst))

    for inst, name, initial in kind_def["analog_values"]:
        _objects[(OBJ_ANALOG_VALUE, inst)] = {
            "name": name, "value": initial, "value_type": "real", "writable": True,
        }
        obj_list.append((OBJ_ANALOG_VALUE, inst))

    for inst, name, initial in kind_def["analog_outputs"]:
        _objects[(OBJ_ANALOG_OUTPUT, inst)] = {
            "name": name, "value": initial, "value_type": "real", "writable": True,
        }
        obj_list.append((OBJ_ANALOG_OUTPUT, inst))

    for inst, name, initial in kind_def["binary_inputs"]:
        _objects[(OBJ_BINARY_INPUT, inst)] = {
            "name": name, "value": initial, "value_type": "bool", "writable": False,
        }
        obj_list.append((OBJ_BINARY_INPUT, inst))

    for inst, name, initial in kind_def["binary_outputs"]:
        _objects[(OBJ_BINARY_OUTPUT, inst)] = {
            "name": name, "value": initial, "value_type": "bool", "writable": True,
        }
        obj_list.append((OBJ_BINARY_OUTPUT, inst))

    _feedback.update(kind_def["feedback"])

    _objects[(OBJ_DEVICE, DEVICE_INSTANCE)] = {
        "name": DEVICE_ID,
        "objectList": obj_list,
    }


# ── BACnet encoding helpers ───────────────────────────────────────────────────

def _app_tag(tag_num: int, data: bytes) -> bytes:
    """Wrap data in a BACnet application tag."""
    n = len(data)
    if n <= 4:
        return bytes([(tag_num << 4) | n]) + data
    elif n <= 253:
        return bytes([(tag_num << 4) | 5, n]) + data
    else:
        return bytes([(tag_num << 4) | 5, 0xFE]) + struct.pack(">H", n) + data


def _ctx_tag(tag_num: int, data: bytes) -> bytes:
    """Wrap data in a BACnet context tag."""
    n = len(data)
    if n <= 4:
        return bytes([(tag_num << 4) | 0x08 | n]) + data
    elif n <= 253:
        return bytes([(tag_num << 4) | 0x08 | 5, n]) + data
    else:
        return bytes([(tag_num << 4) | 0x08 | 5, 0xFE]) + struct.pack(">H", n) + data


def _open_tag(tag_num: int) -> bytes:
    return bytes([(tag_num << 4) | 0x0E])  # (tag<<4) | 0x08 | 0x06


def _close_tag(tag_num: int) -> bytes:
    return bytes([(tag_num << 4) | 0x0F])  # (tag<<4) | 0x08 | 0x07


def _encode_obj_id_bytes(obj_type: int, instance: int) -> bytes:
    """Pack a BACnet Object Identifier as 4 raw bytes."""
    return struct.pack(">I", (obj_type << 22) | (instance & 0x3FFFFF))


# ── BACnet decoding helpers ───────────────────────────────────────────────────

def _decode_tag(data: bytes, pos: int) -> tuple[int, int, int, int]:
    """
    Decode one BACnet tag at pos.
    Returns (tag_num, ctx_class, length, next_pos).
    length=-1 means opening tag, -2 means closing tag.
    """
    b = data[pos];  pos += 1
    tag_num   = (b >> 4) & 0x0F
    ctx_class = (b >> 3) & 0x01
    length    = b & 0x07

    if tag_num == 0x0F:
        tag_num = data[pos];  pos += 1

    if length == 5:
        ext = data[pos];  pos += 1
        if ext == 0xFE:
            length = struct.unpack_from(">H", data, pos)[0];  pos += 2
        elif ext == 0xFF:
            length = struct.unpack_from(">I", data, pos)[0];  pos += 4
        else:
            length = ext
    elif length == 6:
        length = -1   # opening tag
    elif length == 7:
        length = -2   # closing tag

    return tag_num, ctx_class, length, pos


def _strip_bvlc(data: bytes) -> bytes:
    """Remove BVLC header (4 bytes)."""
    if len(data) < 4 or data[0] != 0x81:
        raise ValueError("Not a BACnet/IP frame")
    return data[4:]


def _strip_npci(data: bytes) -> bytes:
    """Remove the NPCI header and return the raw APDU."""
    if len(data) < 2:
        raise ValueError("NPCI too short")
    control = data[1]
    offset  = 2
    if control & 0x20:            # DNET/DADR present
        if len(data) < offset + 3:
            raise ValueError("NPCI DNET truncated")
        dlen = data[offset + 2]
        offset += 3 + dlen + 1   # +1 for hop count that follows DNET
    if control & 0x08:            # SNET/SADR present
        if len(data) < offset + 3:
            raise ValueError("NPCI SNET truncated")
        slen = data[offset + 2]
        offset += 3 + slen
    return data[offset:]


# ── ReadProperty / WriteProperty request parsers ─────────────────────────────
#
# Both services share the same Confirmed-Request-PDU fixed header:
#   byte 0: control (PDU type << 4 | segmentation flags)
#   byte 1: max-segments-accepted / max-response-size
#   byte 2: invoke ID
#   byte 3: service choice (0x0C = ReadProperty, 0x0F = WriteProperty)
#   byte 4+: service-specific parameters

def _parse_read_property(apdu: bytes) -> tuple[int, int, int, int] | None:
    """
    Parse a ReadProperty Confirmed Request APDU.
    Returns (obj_type, obj_inst, prop_id, invoke_id) or None if not a valid request.
    """
    if len(apdu) < 4:
        return None
    pdu_type = (apdu[0] >> 4) & 0x0F
    if pdu_type != 0:      # 0 = Confirmed Service Request
        return None
    invoke_id = apdu[2]
    service   = apdu[3]
    if service != 0x0C:    # 0x0C = ReadProperty
        return None

    pos = 4
    obj_type = obj_inst = prop_id = None

    while pos < len(apdu):
        try:
            tag_num, ctx_class, length, next_pos = _decode_tag(apdu, pos)
        except (IndexError, ValueError):
            break
        if ctx_class == 1 and tag_num == 0 and length == 4:    # context[0] = Object ID
            raw      = apdu[next_pos:next_pos + 4]
            val      = struct.unpack(">I", raw)[0]
            obj_type = (val >> 22) & 0x3FF
            obj_inst = val & 0x3FFFFF
            pos      = next_pos + 4
        elif ctx_class == 1 and tag_num == 1 and length >= 1:  # context[1] = Property ID
            prop_id = int.from_bytes(apdu[next_pos:next_pos + length], 'big')
            pos     = next_pos + length
        else:
            pos = next_pos + length if length >= 0 else next_pos

    if None in (obj_type, obj_inst, prop_id):
        return None
    return obj_type, obj_inst, prop_id, invoke_id


def _parse_write_property(apdu: bytes) -> tuple[int, int, int, int, object] | None:
    """
    Parse a WriteProperty Confirmed Request APDU.

    WriteProperty-Request parameters (ASHRAE 135 clause 15.9):
        context[0]  ObjectIdentifier
        context[1]  PropertyIdentifier
        context[2]  PropertyArrayIndex (optional — not used by any object here)
        context[3]  PropertyValue — OPENING tag, one application-tagged value, CLOSING tag
        context[4]  Priority (optional — ignored; this server applies writes directly,
                    the same simplification used elsewhere in this project instead of
                    a full priority-array/relinquish-default simulation)

    Returns (obj_type, obj_inst, prop_id, invoke_id, new_value) or None.
    """
    if len(apdu) < 4:
        return None
    pdu_type = (apdu[0] >> 4) & 0x0F
    if pdu_type != 0:
        return None
    invoke_id = apdu[2]
    service   = apdu[3]
    if service != 0x0F:    # 0x0F = WriteProperty
        return None

    pos = 4
    obj_type = obj_inst = prop_id = None
    new_value = None

    while pos < len(apdu):
        try:
            tag_num, ctx_class, length, next_pos = _decode_tag(apdu, pos)
        except (IndexError, ValueError):
            break

        if ctx_class == 1 and tag_num == 0 and length == 4:      # Object ID
            raw      = apdu[next_pos:next_pos + 4]
            val      = struct.unpack(">I", raw)[0]
            obj_type = (val >> 22) & 0x3FF
            obj_inst = val & 0x3FFFFF
            pos      = next_pos + 4
        elif ctx_class == 1 and tag_num == 1 and length >= 1:    # Property ID
            prop_id = int.from_bytes(apdu[next_pos:next_pos + length], 'big')
            pos     = next_pos + length
        elif ctx_class == 1 and tag_num == 3 and length == -1:   # PropertyValue opening tag
            # The single application-tagged value sits between this opening
            # tag and its matching closing tag.
            val_tag, val_class, val_len, val_pos = _decode_tag(apdu, next_pos)
            if val_class != 0:
                pos = next_pos
                continue
            raw = apdu[val_pos:val_pos + val_len]
            if val_tag == TAG_REAL and val_len == 4:
                new_value = struct.unpack(">f", raw)[0]
            elif val_tag == TAG_ENUMERATED and val_len >= 1:
                new_value = bool(raw[0])
            pos = val_pos + val_len
        else:
            pos = next_pos + length if length >= 0 else next_pos

    if None in (obj_type, obj_inst, prop_id) or new_value is None:
        return None
    return obj_type, obj_inst, prop_id, invoke_id, new_value


# ── Response builders ─────────────────────────────────────────────────────────

def _wrap_frame(apdu: bytes) -> bytes:
    """Wrap an APDU in NPCI + BVLC for unicast transmission."""
    npci    = bytes([0x01, 0x00])   # version=1, no data-expecting-reply in responses
    payload = npci + apdu
    bvlc    = bytes([0x81, 0x0A]) + struct.pack(">H", 4 + len(payload))
    return bvlc + payload


def _build_ack(invoke_id: int, obj_type: int, obj_inst: int,
               prop_id: int, value_bytes: bytes) -> bytes:
    """Build a ReadProperty Complex-ACK frame."""
    prop_enc = bytes([prop_id]) if prop_id < 256 else struct.pack(">H", prop_id)
    apdu = (
        bytes([0x30, invoke_id & 0xFF, 0x0C])    # Complex-ACK, invoke, ReadProperty
        + _ctx_tag(0, _encode_obj_id_bytes(obj_type, obj_inst))  # echo obj ID
        + _ctx_tag(1, prop_enc)                                   # echo prop ID
        + _open_tag(3)
        + value_bytes
        + _close_tag(3)
    )
    return _wrap_frame(apdu)


def _build_simple_ack(invoke_id: int, service_choice: int) -> bytes:
    """Build a Simple-ACK frame (used for a successful WriteProperty)."""
    apdu = bytes([0x20, invoke_id & 0xFF, service_choice])   # Simple-ACK, invoke, service
    return _wrap_frame(apdu)


def _build_error(invoke_id: int, service_choice: int, error_class: int, error_code: int) -> bytes:
    """Build a BACnet Error PDU."""
    apdu = (
        bytes([0x50, invoke_id & 0xFF, service_choice])    # Error PDU, invoke, service
        + _app_tag(TAG_ENUMERATED, bytes([error_class]))
        + _app_tag(TAG_ENUMERATED, bytes([error_code]))
    )
    return _wrap_frame(apdu)


# ── Property value encoder (ReadProperty) ────────────────────────────────────

def _build_read_response(obj_type: int, obj_inst: int, prop_id: int,
                          invoke_id: int) -> bytes:
    """Look up the object/property and build the appropriate ACK or Error response."""
    obj = _objects.get((obj_type, obj_inst))
    if obj is None:
        return _build_error(invoke_id, 0x0C, 1, 31)   # error-class=object, unknown-object

    if prop_id == PROP_OBJECT_NAME:
        name_bytes = obj['name'].encode('utf-8')
        value = _app_tag(TAG_CHAR_STRING, b'\x00' + name_bytes)  # 0x00 = UTF-8 encoding

    elif prop_id == PROP_PRESENT_VALUE:
        if 'value' not in obj:
            return _build_error(invoke_id, 0x0C, 2, 32)   # error-class=property, unknown-property
        v = obj['value']
        if obj.get('value_type') == 'real':
            value = _app_tag(TAG_REAL, struct.pack('>f', float(v)))
        else:
            value = _app_tag(TAG_ENUMERATED, bytes([1 if v else 0]))

    elif prop_id == PROP_OBJECT_LIST:
        if obj_type != OBJ_DEVICE:
            return _build_error(invoke_id, 0x0C, 2, 32)
        # Each ObjectIdentifier is an application tag 12 with 4 bytes
        value = b"".join(
            _app_tag(TAG_OBJECT_ID, _encode_obj_id_bytes(t, i))
            for t, i in obj.get('objectList', [])
        )

    else:
        return _build_error(invoke_id, 0x0C, 2, 32)   # error-class=property, unknown-property

    return _build_ack(invoke_id, obj_type, obj_inst, prop_id, value)


def _apply_write(obj_type: int, obj_inst: int, prop_id: int,
                  invoke_id: int, new_value: object) -> bytes:
    """Validate and apply a WriteProperty request; build the ACK or Error response."""
    obj = _objects.get((obj_type, obj_inst))
    if obj is None:
        return _build_error(invoke_id, 0x0F, 1, 31)   # unknown-object

    if prop_id != PROP_PRESENT_VALUE:
        return _build_error(invoke_id, 0x0F, 2, 32)   # unknown-property

    if not obj.get('writable', False):
        return _build_error(invoke_id, 0x0F, 2, 3)    # error-class=property, code=write-access-denied

    obj['value'] = new_value
    log.info(
        "WriteProperty(%s,%d) %s -> %s",
        obj_type, obj_inst, obj['name'], new_value,
    )

    # Cascade to a linked feedback object (e.g. FanCommand BO -> FanStatus BI)
    # so the effect of the write is independently observable via a read.
    linked = _feedback.get((obj_type, obj_inst))
    if linked is not None and linked in _objects:
        _objects[linked]['value'] = new_value
        log.info("  feedback -> %s = %s", _objects[linked]['name'], new_value)

    return _build_simple_ack(invoke_id, 0x0F)


# ── Process simulation ────────────────────────────────────────────────────────

async def _simulate() -> None:
    """Drift every read-only analog-input present-value every 2 seconds."""
    while True:
        await asyncio.sleep(2)
        for key, obj in _objects.items():
            if key[0] == OBJ_ANALOG_INPUT and 'drift' in obj:
                obj['value'] = max(0.0, obj['value'] + random.uniform(-obj['drift'], obj['drift']))


# ── asyncio UDP protocol ──────────────────────────────────────────────────────

class _BACnetProtocol(asyncio.DatagramProtocol):
    """asyncio DatagramProtocol that handles incoming BACnet/IP unicast packets."""

    def __init__(self) -> None:
        self.transport: asyncio.DatagramTransport | None = None

    def connection_made(self, transport: asyncio.DatagramTransport) -> None:  # type: ignore[override]
        self.transport = transport
        log.info("BACnet/IP server listening on UDP port %d", PORT)

    def datagram_received(self, data: bytes, addr: tuple) -> None:
        try:
            self._handle(data, addr)
        except Exception as exc:
            log.warning("Error handling packet from %s: %s", addr, exc)

    def _handle(self, data: bytes, addr: tuple) -> None:
        # Strip BVLC (4 bytes) — reject non-BACnet frames silently
        try:
            npci_apdu = _strip_bvlc(data)
            apdu      = _strip_npci(npci_apdu)
        except ValueError:
            return

        if len(apdu) < 4:
            return
        service = apdu[3]

        if service == 0x0C:
            parsed = _parse_read_property(apdu)
            if parsed is None:
                return
            obj_type, obj_inst, prop_id, invoke_id = parsed
            response = _build_read_response(obj_type, obj_inst, prop_id, invoke_id)
            action = "ReadProperty"
        elif service == 0x0F:
            parsed = _parse_write_property(apdu)
            if parsed is None:
                return
            obj_type, obj_inst, prop_id, invoke_id, new_value = parsed
            response = _apply_write(obj_type, obj_inst, prop_id, invoke_id, new_value)
            action = "WriteProperty"
        else:
            return  # unsupported service — ignore silently

        if self.transport:
            self.transport.sendto(response, addr)
            log.info(
                "%s(%s,%d, prop=%d) -> %d bytes to %s",
                action, obj_type, obj_inst, prop_id, len(response), addr,
            )

    def error_received(self, exc: Exception) -> None:
        log.warning("UDP error: %s", exc)


# ── Main ──────────────────────────────────────────────────────────────────────

async def main() -> None:
    _init_objects()

    log.info(
        "BACnet/IP device starting — id=%s  category=%s  kind=%s  instance=%d  port=%d",
        DEVICE_ID, CATEGORY, KIND, DEVICE_INSTANCE, PORT,
    )
    for (obj_type, inst), obj in _objects.items():
        if obj_type == OBJ_DEVICE:
            continue
        type_name = {
            OBJ_ANALOG_INPUT: "AI", OBJ_ANALOG_OUTPUT: "AO", OBJ_ANALOG_VALUE: "AV",
            OBJ_BINARY_INPUT: "BI", OBJ_BINARY_OUTPUT: "BO",
        }.get(obj_type, "?")
        writable = " (writable)" if obj.get("writable") else ""
        log.info("  %s:%d %s%s", type_name, inst, obj["name"], writable)

    loop = asyncio.get_event_loop()
    transport, _ = await loop.create_datagram_endpoint(
        _BACnetProtocol,
        local_addr=("0.0.0.0", PORT),
    )

    log.info("Device ready — serving ReadProperty/WriteProperty requests")

    try:
        asyncio.create_task(_simulate())
        await asyncio.Future()   # run until the container is killed
    finally:
        transport.close()


if __name__ == "__main__":
    asyncio.run(main())

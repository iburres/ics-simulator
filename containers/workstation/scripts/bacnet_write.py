#!/usr/bin/env python3
"""
bacnet_write.py — Write a BACnet/IP analog or binary present-value.

Usage:
    python3 bacnet_write.py <host> <object-type>,<instance> <value> [--port 47808]

Object types accepted: analog-value (av), analog-output (ao), binary-output (bo)
Values: a number for analog-value/analog-output (e.g. 15.5), or on/off/true/false
        for binary-output.

Examples:
    # Raise an AHU's supply-air-temperature setpoint (AV:1) to 15.5 C
    python3 bacnet_write.py 10.200.10.13 av,1 15.5

    # Command a chiller off via its BO:1 command point
    python3 bacnet_write.py 10.200.10.14 bo,1 off

Protocol:  BACnet/IP (ASHRAE 135, UDP port 47808)
Service:   WriteProperty — presentValue, no priority (direct write; see
           containers/bacnet/server.py for why this project simplifies away
           the full BACnet priority-array/relinquish-default model)

This is the "operate" counterpart to bacnet_discover.py's read-only survey —
run that first to see which objects on a device are writable.
"""

import argparse
import socket
import struct
import sys

# ── BACnet object type codes (ASHRAE 135 Table 12-1) ────────────────────────
OBJ_ANALOG_OUTPUT = 1
OBJ_ANALOG_VALUE  = 2
OBJ_BINARY_OUTPUT = 4

TYPE_ALIASES = {
    "av": OBJ_ANALOG_VALUE, "analog-value": OBJ_ANALOG_VALUE,
    "ao": OBJ_ANALOG_OUTPUT, "analog-output": OBJ_ANALOG_OUTPUT,
    "bo": OBJ_BINARY_OUTPUT, "binary-output": OBJ_BINARY_OUTPUT,
}

# ── BACnet property identifier codes (ASHRAE 135 Table 12-2) ────────────────
PROP_PRESENT_VALUE = 85   # 0x55

# ── BACnet application tag numbers ──────────────────────────────────────────
TAG_REAL       = 4   # 32-bit IEEE 754 float
TAG_ENUMERATED = 9   # enumeration (binary present-value: 0=inactive, 1=active)


# ── Encoding helpers (same conventions as bacnet_discover.py / server.py) ───

def encode_object_id(obj_type: int, instance: int) -> bytes:
    return struct.pack(">I", (obj_type << 22) | (instance & 0x3FFFFF))


def context_tag(tag_num: int, data: bytes) -> bytes:
    n = len(data)
    if n <= 4:
        return bytes([(tag_num << 4) | 0x08 | n]) + data
    elif n <= 253:
        return bytes([(tag_num << 4) | 0x08 | 5, n]) + data
    else:
        return bytes([(tag_num << 4) | 0x08 | 5, 0xFE]) + struct.pack(">H", n) + data


def opening_tag(tag_num: int) -> bytes:
    return bytes([(tag_num << 4) | 0x0E])


def closing_tag(tag_num: int) -> bytes:
    return bytes([(tag_num << 4) | 0x0F])


def application_tag(tag_num: int, data: bytes) -> bytes:
    n = len(data)
    return bytes([(tag_num << 4) | n]) + data


def build_write_property(invoke_id: int, obj_type: int, instance: int,
                          value_bytes: bytes) -> bytes:
    """
    Build a complete BACnet/IP WriteProperty request frame targeting presentValue.

    APDU layout — same Confirmed-Request-PDU header as ReadProperty, service
    choice 0x0F instead of 0x0C, plus a context[3] opening/value/closing tag
    for the value being written. No context[4] priority is sent — this
    project's servers apply writes directly (see server.py's docstring).
    """
    obj_bytes  = context_tag(0, encode_object_id(obj_type, instance))
    prop_bytes = context_tag(1, bytes([PROP_PRESENT_VALUE]))
    value_pdu  = opening_tag(3) + value_bytes + closing_tag(3)

    apdu = bytes([0x00, 0x04, invoke_id & 0xFF, 0x0F]) + obj_bytes + prop_bytes + value_pdu

    npci = bytes([0x01, 0x04])   # version=1, data_expecting_reply
    payload = npci + apdu
    bvlc = bytes([0x81, 0x0A]) + struct.pack(">H", 4 + len(payload))
    return bvlc + payload


# ── Decoding helpers ─────────────────────────────────────────────────────────

def strip_bvlc(data: bytes) -> bytes:
    if len(data) < 4 or data[0] != 0x81:
        raise ValueError(f"Not a BACnet/IP frame (first byte: 0x{data[0]:02X})")
    return data[4:]


def strip_npci(data: bytes) -> bytes:
    if len(data) < 2:
        raise ValueError("NPCI too short")
    control = data[1]
    offset = 2
    if control & 0x20:
        if len(data) < offset + 3:
            raise ValueError("NPCI DNET truncated")
        dlen = data[offset + 2]
        offset += 3 + dlen + 1
    if control & 0x08:
        if len(data) < offset + 3:
            raise ValueError("NPCI SNET truncated")
        slen = data[offset + 2]
        offset += 3 + slen
    return data[offset:]


def parse_response(raw: bytes) -> str:
    """
    Classify a WriteProperty response frame.

    Returns "ok", "denied" (write-access-denied — the object is read-only),
    "error" (some other BACnet error), or "unknown".
    """
    try:
        apdu = strip_npci(strip_bvlc(raw))
    except ValueError:
        return "unknown"
    if len(apdu) < 1:
        return "unknown"
    pdu_type = (apdu[0] >> 4) & 0x0F
    if pdu_type == 2:   # Simple-ACK
        return "ok"
    if pdu_type == 5:   # Error PDU
        return "denied" if len(apdu) >= 5 and apdu[4] == 3 else "error"
    return "unknown"


# ── Value encoding ────────────────────────────────────────────────────────────

def encode_value(obj_type: int, raw_value: str) -> bytes:
    """Encode the CLI value argument as the application-tagged bytes WriteProperty needs."""
    if obj_type == OBJ_BINARY_OUTPUT:
        truthy = raw_value.strip().lower() in ("on", "true", "1", "active", "close", "closed")
        falsy  = raw_value.strip().lower() in ("off", "false", "0", "inactive", "open")
        if not (truthy or falsy):
            raise ValueError(f"'{raw_value}' is not a recognized on/off value for a binary-output")
        return application_tag(TAG_ENUMERATED, bytes([1 if truthy else 0]))
    else:
        try:
            f = float(raw_value)
        except ValueError:
            raise ValueError(f"'{raw_value}' is not a valid number for an analog point")
        return application_tag(TAG_REAL, struct.pack(">f", f))


# ── Main ──────────────────────────────────────────────────────────────────────

def write_point(host: str, port: int, obj_type: int, instance: int,
                 raw_value: str, timeout: float) -> None:
    value_bytes = encode_value(obj_type, raw_value)
    request = build_write_property(0, obj_type, instance, value_bytes)

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(timeout)
    try:
        print(f"[bacnet] Sending WriteProperty {raw_value!r} to "
              f"type={obj_type},{instance} at {host}:{port}")
        sock.sendto(request, (host, port))
        try:
            resp, _ = sock.recvfrom(4096)
        except socket.timeout:
            print("[bacnet] No response — is the simulation running?")
            sys.exit(1)
    finally:
        sock.close()

    result = parse_response(resp)
    if result == "ok":
        print("[bacnet] Write accepted.")
    elif result == "denied":
        print("[bacnet] Write REJECTED — this object is read-only (write-access-denied).")
        sys.exit(1)
    else:
        print(f"[bacnet] Write failed ({result}).")
        sys.exit(1)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="BACnet/IP presentValue writer (raw UDP — no bacpypes3 required)"
    )
    parser.add_argument("host", help="IP address of the BACnet device")
    parser.add_argument(
        "object", metavar="type,instance",
        help="Object to write, e.g. av,1 or bo,1 (types: av/analog-value, "
             "ao/analog-output, bo/binary-output)"
    )
    parser.add_argument("value", help="New value: a number, or on/off for binary-output")
    parser.add_argument("--port", type=int, default=47808)
    parser.add_argument("--timeout", type=float, default=3.0)
    args = parser.parse_args()

    try:
        type_str, inst_str = args.object.split(",", 1)
        obj_type = TYPE_ALIASES.get(type_str.strip().lower())
        if obj_type is None:
            raise ValueError(
                f"Unknown object type '{type_str}' — use av, ao, or bo"
            )
        instance = int(inst_str)
    except ValueError as exc:
        print(f"[bacnet] ERROR: invalid object argument '{args.object}': {exc}")
        sys.exit(1)

    try:
        write_point(args.host, args.port, obj_type, instance, args.value, args.timeout)
    except ValueError as exc:
        print(f"[bacnet] ERROR: {exc}")
        sys.exit(1)

    print("[bacnet] Done.")


if __name__ == "__main__":
    main()

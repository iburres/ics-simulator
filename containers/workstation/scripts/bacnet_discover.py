#!/usr/bin/env python3
"""
bacnet_discover.py — Read BACnet/IP device objects and process values.

Usage:
    python3 bacnet_discover.py <host> [--port 47808] [--instance 1001]

Examples:
    python3 bacnet_discover.py 10.200.10.13
    python3 bacnet_discover.py 10.200.10.13 --instance 1001

Protocol:  BACnet/IP (ASHRAE 135, UDP port 47808)
Services:  ReadProperty — objectList, presentValue, objectName

How it works
------------
BACnet/IP messages travel over UDP as three stacked headers:

  [BVLC header — 4 bytes]
      0x81 (BACnet/IP marker), function (0x0A unicast), total length
    └─ [NPCI — 2 bytes]
           protocol version + control flags
         └─ [APDU — application PDU]
                service type + object/property identifiers + encoded values

This script uses raw UDP sockets rather than a bacpypes3 Application stack
so it works regardless of the bacpypes3 version installed on the workstation.
"""

import argparse
import socket
import struct
import sys

# ── BACnet object type codes (ASHRAE 135 Table 12-1) ────────────────────────
OBJ_ANALOG_INPUT  = 0
OBJ_ANALOG_OUTPUT = 1
OBJ_ANALOG_VALUE  = 2
OBJ_BINARY_INPUT  = 3
OBJ_BINARY_OUTPUT = 4
OBJ_BINARY_VALUE  = 5
OBJ_DEVICE        = 8

# Human-readable names for the types we display
OBJ_TYPE_NAMES = {
    OBJ_ANALOG_INPUT:  "analog-input",
    OBJ_ANALOG_OUTPUT: "analog-output",
    OBJ_ANALOG_VALUE:  "analog-value",
    OBJ_BINARY_INPUT:  "binary-input",
    OBJ_BINARY_OUTPUT: "binary-output",
    OBJ_DEVICE:        "device",
}

# analog-value/analog-output/binary-output are the writable object types this
# project's BACnet devices expose (see bacnet_write.py) — flagged here purely
# for the "(writable)" hint in the printed table, not for any protocol reason.
WRITABLE_TYPES = {OBJ_ANALOG_OUTPUT, OBJ_ANALOG_VALUE, OBJ_BINARY_OUTPUT}

# ── BACnet property identifier codes (ASHRAE 135 Table 12-2) ────────────────
PROP_OBJECT_LIST  = 76    # 0x4C
PROP_OBJECT_NAME  = 77    # 0x4D
PROP_PRESENT_VALUE = 85   # 0x55

# ── BACnet application tag numbers ──────────────────────────────────────────
TAG_REAL        = 4   # 32-bit IEEE 754 float
TAG_CHAR_STRING = 7   # character string (encoding-byte + UTF-8 data)
TAG_ENUMERATED  = 9   # enumeration (binary-input active/inactive)
TAG_OBJECT_ID   = 12  # 32-bit encoded (type<<22 | instance)


# ── Encoding helpers ─────────────────────────────────────────────────────────

def encode_object_id(obj_type: int, instance: int) -> bytes:
    """Pack a BACnet Object Identifier into 4 bytes (big-endian)."""
    return struct.pack(">I", (obj_type << 22) | (instance & 0x3FFFFF))


def context_tag(tag_num: int, data: bytes) -> bytes:
    """
    Wrap data bytes in a BACnet context tag.

    BACnet context tag byte: (tag_num << 4) | 0x08 | length_or_ext
      length 0-4: encoded directly in bits 2-0
      length 5-253: bits 2-0 = 5 (extended), actual length in next byte
    """
    n = len(data)
    if n <= 4:
        return bytes([(tag_num << 4) | 0x08 | n]) + data
    elif n <= 253:
        return bytes([(tag_num << 4) | 0x08 | 5, n]) + data
    else:
        return bytes([(tag_num << 4) | 0x08 | 5, 0xFE]) + struct.pack(">H", n) + data


def build_read_property(invoke_id: int, obj_type: int, instance: int, prop_id: int) -> bytes:
    """
    Build a complete BACnet/IP ReadProperty request frame.

    Frame structure (total ≈ 17 bytes for a single-byte property ID):
      BVLC (4 bytes) + NPCI (2 bytes) + APDU (11 bytes)

    APDU layout:
      0x00        — Confirmed Service Request PDU type (no segmentation)
      0x04        — MaxSegs=0 (unspecified), MaxAPDU encoding 4 (1024 bytes)
      invoke_id   — request sequence number (0-255, echoed in ACK)
      0x0C        — Service choice: ReadProperty
      context[0]  — Object Identifier (4-byte encoded type+instance)
      context[1]  — Property Identifier (1 or 2 bytes depending on value)
    """
    obj_bytes = context_tag(0, encode_object_id(obj_type, instance))
    # Property IDs in this lab are all < 256 so one byte suffices
    if prop_id < 256:
        prop_bytes = context_tag(1, bytes([prop_id]))
    else:
        prop_bytes = context_tag(1, struct.pack(">H", prop_id))

    apdu = bytes([0x00, 0x04, invoke_id & 0xFF, 0x0C]) + obj_bytes + prop_bytes

    # NPCI: version=1, data_expecting_reply (no routing headers)
    npci = bytes([0x01, 0x04])

    payload = npci + apdu
    # BVLC: BACnet/IP (0x81), Original-Unicast (0x0A), total length
    bvlc = bytes([0x81, 0x0A]) + struct.pack(">H", 4 + len(payload))
    return bvlc + payload


# ── Decoding helpers ─────────────────────────────────────────────────────────

def strip_bvlc(data: bytes) -> bytes:
    """Remove the 4-byte BVLC header and return the NPCI+APDU payload."""
    if len(data) < 4 or data[0] != 0x81:
        raise ValueError(f"Not a BACnet/IP frame (first byte: 0x{data[0]:02X})")
    return data[4:]


def strip_npci(data: bytes) -> bytes:
    """
    Remove the NPCI header and return the raw APDU.

    NPCI may include optional DNET/DADR (destination), SNET/SADR (source),
    and a hop-count byte. All are skipped here since this client only
    communicates with directly reachable unicast devices (no routers).
    """
    if len(data) < 2:
        raise ValueError("NPCI too short")
    control = data[1]
    offset = 2

    # Destination network specifier (bit 5): DNET(2) + DLEN(1) + DADR(DLEN bytes)
    if control & 0x20:
        if len(data) < offset + 3:
            raise ValueError("NPCI DNET truncated")
        dlen = data[offset + 2]
        offset += 3 + dlen
        offset += 1  # hop count always follows DNET

    # Source network specifier (bit 3): SNET(2) + SLEN(1) + SADR(SLEN bytes)
    if control & 0x08:
        if len(data) < offset + 3:
            raise ValueError("NPCI SNET truncated")
        slen = data[offset + 2]
        offset += 3 + slen

    return data[offset:]


def decode_tag(data: bytes, pos: int) -> tuple[int, int, int, int]:
    """
    Decode one BACnet tag at position pos.

    BACnet tag byte layout:
      bits 7-4: tag number (0-14; 15 means extended — next byte is actual tag)
      bit 3:    class (0 = application, 1 = context)
      bits 2-0: length/type
                  0-4  = value length in bytes
                  5    = extended length (actual length in next 1 or 3 bytes)
                  6    = opening tag (for constructed values)
                  7    = closing tag (for constructed values)

    Returns (tag_num, context_class, length, next_pos)
      length = -1 means opening tag, -2 means closing tag.
    """
    if pos >= len(data):
        raise ValueError("Tag read past end of buffer")
    b = data[pos]
    tag_num = (b >> 4) & 0x0F
    ctx_class = (b >> 3) & 0x01   # 1 = context, 0 = application
    length = b & 0x07
    pos += 1

    if tag_num == 0x0F:            # extended tag number in next byte
        if pos >= len(data):
            raise ValueError("Extended tag number missing")
        tag_num = data[pos]
        pos += 1

    if length == 5:                # extended length
        if pos >= len(data):
            raise ValueError("Extended length byte missing")
        ext = data[pos];  pos += 1
        if ext == 0xFE:
            length = struct.unpack_from(">H", data, pos)[0];  pos += 2
        elif ext == 0xFF:
            length = struct.unpack_from(">I", data, pos)[0];  pos += 4
        else:
            length = ext
    elif length == 6:              # opening context tag
        length = -1
    elif length == 7:              # closing context tag
        length = -2

    return tag_num, ctx_class, length, pos


def _skip_to_value_section(apdu: bytes) -> int:
    """
    Skip the ReadProperty-ACK header fields (context[0], context[1])
    and the opening context[3] tag.  Returns the position of the first
    value byte, or -1 if the opening tag is not found.

    ReadProperty-ACK layout:
      byte 0: PDU type (Complex-ACK = 0x30 | invoke)
      byte 1: invoke ID
      byte 2: service choice (ReadProperty = 0x0C)
      context[0] — echoed Object Identifier
      context[1] — echoed Property Identifier
      context[3] opening tag  ← we want pos just after this
        <value(s)>
      context[3] closing tag
    """
    if len(apdu) < 3 or (apdu[0] & 0xF0) != 0x30:
        return -1
    pos = 3
    while pos < len(apdu):
        try:
            tag_num, ctx_class, length, next_pos = decode_tag(apdu, pos)
        except ValueError:
            return -1
        if ctx_class == 1 and tag_num == 3 and length == -1:
            return next_pos   # just after the opening tag
        if length >= 0:
            pos = next_pos + length
        else:
            pos = next_pos
    return -1


def decode_object_list(apdu: bytes) -> list[tuple[int, int]]:
    """
    Parse a ReadProperty-ACK for the objectList property.

    Returns a list of (obj_type, instance) tuples — one per object on the device.
    The device object itself is typically the first entry; analog-input and
    binary-input objects follow.
    """
    start = _skip_to_value_section(apdu)
    if start < 0:
        return []

    results: list[tuple[int, int]] = []
    pos = start
    while pos < len(apdu):
        try:
            tag_num, ctx_class, length, next_pos = decode_tag(apdu, pos)
        except ValueError:
            break
        # Closing tag 3 marks end of the object list
        if ctx_class == 1 and tag_num == 3 and length == -2:
            break
        # Application tag 12 = Object Identifier, always 4 bytes
        if ctx_class == 0 and tag_num == TAG_OBJECT_ID and length == 4:
            raw = apdu[next_pos:next_pos + 4]
            val = struct.unpack(">I", raw)[0]
            results.append(((val >> 22) & 0x3FF, val & 0x3FFFFF))
            pos = next_pos + 4
        elif length >= 0:
            pos = next_pos + length
        else:
            pos = next_pos
    return results


def decode_present_value(apdu: bytes) -> str:
    """
    Parse a ReadProperty-ACK for the presentValue property.

    Handles:
      Tag 4 (Real, 4 bytes)   — analog-input present value
      Tag 9 (Enumerated)      — binary-input present value (0=inactive, 1=active)
    """
    start = _skip_to_value_section(apdu)
    if start < 0:
        return "(bad ACK)"
    pos = start
    while pos < len(apdu):
        try:
            tag_num, ctx_class, length, next_pos = decode_tag(apdu, pos)
        except ValueError:
            break
        if ctx_class == 1 and tag_num == 3 and length == -2:
            break
        if ctx_class == 0 and length >= 0:
            raw = apdu[next_pos:next_pos + length]
            if tag_num == TAG_REAL and length == 4:
                return f"{struct.unpack('>f', raw)[0]:.2f}"
            if tag_num == TAG_ENUMERATED and length >= 1:
                return "active" if raw[0] else "inactive"
        if length >= 0:
            pos = next_pos + length
        else:
            pos = next_pos
    return "(unknown)"


def decode_object_name(apdu: bytes) -> str:
    """
    Parse a ReadProperty-ACK for the objectName property.

    BACnet CharacterString value: 1-byte encoding indicator (0=UTF-8) + string bytes.
    """
    start = _skip_to_value_section(apdu)
    if start < 0:
        return "(bad ACK)"
    pos = start
    while pos < len(apdu):
        try:
            tag_num, ctx_class, length, next_pos = decode_tag(apdu, pos)
        except ValueError:
            break
        if ctx_class == 1 and tag_num == 3 and length == -2:
            break
        if ctx_class == 0 and tag_num == TAG_CHAR_STRING and length >= 1:
            raw = apdu[next_pos:next_pos + length]
            # raw[0] = character-set (0 = UTF-8); raw[1:] = string bytes
            return raw[1:].decode("utf-8", errors="replace")
        if length >= 0:
            pos = next_pos + length
        else:
            pos = next_pos
    return "(no name)"


# ── Network I/O ──────────────────────────────────────────────────────────────

def send_recv(sock: socket.socket, request: bytes, target: tuple,
              timeout: float) -> bytes | None:
    """Send a BACnet request and return the response bytes, or None on timeout."""
    sock.sendto(request, target)
    sock.settimeout(timeout)
    try:
        data, _ = sock.recvfrom(4096)
        return data
    except socket.timeout:
        return None


def parse_response(raw: bytes) -> bytes | None:
    """Strip BVLC+NPCI framing and return the APDU, or None on error."""
    try:
        return strip_npci(strip_bvlc(raw))
    except ValueError:
        return None


# ── Main poll ────────────────────────────────────────────────────────────────

def poll_device(host: str, port: int, instance: int, timeout: float) -> None:
    target = (host, port)
    invoke = 0

    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        print(f"[bacnet] Sending ReadProperty to device,{instance} at {host}:{port}")

        # Step 1 — Read the object list to discover all objects on the device
        req  = build_read_property(invoke, OBJ_DEVICE, instance, PROP_OBJECT_LIST)
        resp = send_recv(sock, req, target, timeout)
        if resp is None:
            print("[bacnet] No response — is the simulation running?")
            return

        apdu = parse_response(resp)
        if apdu is None or (apdu[0] & 0xF0) == 0x50:  # 0x50 = Error PDU
            print("[bacnet] Device returned an error or unreadable frame")
            return

        object_list = decode_object_list(apdu)
        if not object_list:
            print("[bacnet] Empty or unreadable object list")
            return

        readable = [(t, i) for t, i in object_list if t in OBJ_TYPE_NAMES and t != OBJ_DEVICE]

        print(f"\n[bacnet] Device {instance} — {len(object_list)} objects total, "
              f"{len(readable)} readable:\n")
        print(f"  {'Object':<32} {'Name':<26} {'Present Value'}")
        print("  " + "-" * 70)

        # Step 2 — For each object, read present-value and object-name
        for obj_type, obj_inst in readable:
            invoke = (invoke + 1) & 0xFF
            type_name = OBJ_TYPE_NAMES.get(obj_type, f"type-{obj_type}")

            pv_req  = build_read_property(invoke, obj_type, obj_inst, PROP_PRESENT_VALUE)
            pv_raw  = send_recv(sock, pv_req, target, timeout)
            pv_str  = decode_present_value(parse_response(pv_raw) or b"") \
                      if pv_raw else "(timeout)"
            if obj_type in WRITABLE_TYPES:
                pv_str += "  (writable — see bacnet_write.py)"

            invoke = (invoke + 1) & 0xFF

            name_req  = build_read_property(invoke, obj_type, obj_inst, PROP_OBJECT_NAME)
            name_raw  = send_recv(sock, name_req, target, timeout)
            name_str  = decode_object_name(parse_response(name_raw) or b"") \
                        if name_raw else "(timeout)"

            label = f"{type_name},{obj_inst}"
            print(f"  {label:<32} {name_str:<26} {pv_str}")

    finally:
        sock.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="BACnet/IP device reader (raw UDP — no bacpypes3 required)"
    )
    parser.add_argument("host",           help="IP address of the BACnet device")
    parser.add_argument("--port",     type=int,   default=47808)
    parser.add_argument("--instance", type=int,   default=1001)
    parser.add_argument("--timeout",  type=float, default=3.0)
    args = parser.parse_args()

    try:
        poll_device(args.host, args.port, args.instance, args.timeout)
    except Exception as exc:
        print(f"[bacnet] ERROR: {exc}")
        sys.exit(1)

    print("\n[bacnet] Done.")


if __name__ == "__main__":
    main()

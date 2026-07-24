#!/usr/bin/env python3
"""
sidecar.py — Modbus-to-MQTT bridge for the ICS Simulator iot-gateway device.

Runs alongside a real Mosquitto broker (started by entrypoint.sh, listening
on localhost:MQTT_PORT) in the same container. This process has two jobs:

  1. Polls the Modbus field devices (smart-sensor/smart-controller) wired to
     this gateway on the canvas, exactly the same "field I/O in" role
     containers/dcs/server.py already plays — same fresh-connection-per-
     cycle polling style, same Coil0/HoldingReg0 read shape.
  2. Republishes each field device's values as MQTT PUBLISH packets onto the
     SAME broker that any wired iiot-sensor nodes are already publishing
     directly to — unifying Modbus-only field devices and native MQTT
     publishers under one consistent topic scheme (otforge/<nodeId>/value)
     on one broker, one place for a student to inspect the whole picture.

This is the "aggregation and re-exposure over a different real protocol"
pattern already established by the DCS controller (Modbus-in, OPC-UA-out)
and the PMU (Modbus-in, C37.118-out), applied here as Modbus-in, MQTT-out —
except this device ALSO hosts the broker its own MQTT-out side publishes to,
which is also where directly-wired iiot-sensor nodes publish. No write-down
to field devices (read-only upward, deliberately) — same scope cut DCS made
and for the same reason: this is the aggregation/visibility layer, not a
second control path.

Topic: otforge/<fieldDeviceNodeId>/value — same scheme containers/iiot-
sensor/server.py uses for its own direct publishes, so both sources appear
consistently under one topic namespace.

Payload (JSON): {"value": <float>, "source": "modbus-bridge", "timestamp": "<ISO8601>"}

Environment variables:
    DEVICE_ID              — node identifier string, used in logging
    DEVICE_CATEGORY        — logged at startup for Docker Compose traceability
    MQTT_PORT              — local broker port this sidecar publishes to
                             (default 1883 — must match mosquitto.conf's
                             listener, which the same MQTT_PORT env var
                             also configures via entrypoint.sh)
    GATEWAY_FIELD_DEVICES  — comma-separated "nodeId|ip" pairs, one per
                             field device wired to this gateway on the
                             canvas (compose-generator.ts derives this from
                             canvas edges — see connectionRules.ts's
                             iot-gateway.smart-sensor/smart-controller
                             entries). Empty/unset means the gateway was
                             placed but not wired to any field devices yet;
                             the sidecar still starts cleanly and the
                             broker remains available for directly-wired
                             iiot-sensor publishers.

Protocol references: Modbus Application Protocol Specification (field I/O
polling), MQTT Version 3.1.1 (OASIS Standard).
Library versions: pymodbus 3.7.4 (client mode, same pin as containers/dcs),
paho-mqtt 2.1.0 (client mode, same pin as containers/iiot-sensor).
"""

import asyncio
import json
import logging
import os
from datetime import datetime, timezone

import paho.mqtt.client as mqtt
from pymodbus.client import AsyncModbusTcpClient

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ics-iot-gateway")

DEVICE_ID = os.getenv("DEVICE_ID", "gateway-1")
CATEGORY = os.getenv("DEVICE_CATEGORY", "iot-gateway")
MQTT_PORT = int(os.getenv("MQTT_PORT", "1883"))

MODBUS_PORT = 502
# Field devices in this simulator are seeded at Modbus unit id 1 by default,
# same assumption containers/dcs/server.py already makes for the same reason.
FIELD_DEVICE_UNIT_ID = 1

POLL_INTERVAL_SECONDS = 2
POLL_TIMEOUT_SECONDS = 3


def parse_field_devices(raw: str) -> list[tuple[str, str]]:
    """
    Parses GATEWAY_FIELD_DEVICES ("nodeId|ip,nodeId|ip,...") into a list of
    (nodeId, ip) tuples. Malformed entries are logged and skipped rather
    than raising — one bad entry must not take down the whole gateway.
    Identical parsing shape to containers/dcs/server.py's parse_field_devices().
    """
    devices: list[tuple[str, str]] = []
    for entry in raw.split(","):
        entry = entry.strip()
        if not entry:
            continue
        parts = entry.split("|")
        if len(parts) != 2:
            log.warning("Skipping malformed GATEWAY_FIELD_DEVICES entry: %r", entry)
            continue
        node_id, ip = parts[0].strip(), parts[1].strip()
        if node_id and ip:
            devices.append((node_id, ip))
    return devices


async def poll_field_device(node_id: str, ip: str) -> float | None:
    """
    Opens a fresh Modbus TCP client connection to one field device, reads
    Holding Register 0 (FC03), then closes the connection. Same fresh-
    connection-per-cycle approach as containers/dcs/server.py's
    poll_field_device() and for the same reason: simpler, more robust
    recovery than a persistent per-device client.
    """
    client = AsyncModbusTcpClient(ip, port=MODBUS_PORT, timeout=POLL_TIMEOUT_SECONDS)
    value: float | None = None
    try:
        await client.connect()
        if not client.connected:
            log.warning("%s (%s): connection failed", node_id, ip)
            return None
        hr_result = await client.read_holding_registers(0, count=1, slave=FIELD_DEVICE_UNIT_ID)
        if not hr_result.isError():
            value = float(hr_result.registers[0])
    except Exception as exc:  # noqa: BLE001 — one field device's failure must not crash the poll loop
        log.warning("%s (%s): poll error — %s", node_id, ip, exc)
    finally:
        client.close()
    return value


async def poll_loop(field_devices: list[tuple[str, str]], mqtt_client: mqtt.Client) -> None:
    """
    Background task — polls every field device every POLL_INTERVAL_SECONDS
    and republishes each successfully-read value onto the local broker.
    Each field device's poll+publish is wrapped in its own try/except, same
    isolation reasoning as containers/dcs/server.py's poll_loop().
    """
    if not field_devices:
        log.info("No field devices configured — bridging nothing, broker still available for iiot-sensor publishers.")
        return

    while True:
        for node_id, ip in field_devices:
            try:
                value = await poll_field_device(node_id, ip)
                if value is not None:
                    payload = json.dumps({
                        "value": value,
                        "source": "modbus-bridge",
                        "timestamp": datetime.now(timezone.utc).isoformat(),
                    })
                    mqtt_client.publish(f"otforge/{node_id}/value", payload, qos=0)
            except Exception as exc:  # noqa: BLE001 — one field device's publish failing must not end polling for the rest
                log.warning("%s: bridge error — %s", node_id, exc)
        await asyncio.sleep(POLL_INTERVAL_SECONDS)


async def main() -> None:
    field_devices = parse_field_devices(os.getenv("GATEWAY_FIELD_DEVICES", ""))
    log.info(
        "IoT gateway starting -- id=%s  category=%s  mqtt_port=%d  field_devices=%s",
        DEVICE_ID, CATEGORY, MQTT_PORT,
        ", ".join(f"{n}@{ip}" for n, ip in field_devices) or "(none)",
    )

    mqtt_client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"{DEVICE_ID}-sidecar")

    def on_connect(_client, _userdata, _flags, reason_code, _properties=None):
        if reason_code == 0:
            log.info("Sidecar connected to local broker on 127.0.0.1:%d", MQTT_PORT)
        else:
            log.warning("Sidecar connect to local broker failed: %s", reason_code)

    mqtt_client.on_connect = on_connect
    mqtt_client.connect_async("127.0.0.1", MQTT_PORT, keepalive=30)
    mqtt_client.loop_start()

    await poll_loop(field_devices, mqtt_client)
    await asyncio.Future()  # run until cancelled (only reached if field_devices was empty)


if __name__ == "__main__":
    asyncio.run(main())

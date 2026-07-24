#!/usr/bin/env python3
"""
server.py — IIoT wireless sensor node for the ICS Simulator (real MQTT publisher).

Generates a synthetic process value using the exact same waveform math already
proven in containers/modbus/server.py's _sensor_value_at() (sine/random/
sawtooth/square/constant, per SensorConfig — packages/schema/src/icslab.ts),
then publishes it as a real MQTT PUBLISH packet to the wired iot-gateway's
broker. Reimplemented standalone rather than imported/shared, matching the
convention every device container in this project follows: each is an
independently self-contained image with no shared Python module between them.

Unlike smart-sensor (a Modbus TCP server a PLC polls), an IIoT sensor node
never gets polled — it pushes its own readings on its own schedule, the
actual behavior WirelessHART/ISA100.11a/MQTT-publisher field devices exhibit
in a real plant, and the reason connectionRules.ts deliberately keeps this
category from connecting directly to PLCs/historians: it only ever talks to
its gateway.

Topic: otforge/<DEVICE_ID>/value (or SENSOR_TAG_NAME if set, mirroring
SensorConfig.tagName's role as a FUXA tag override — same "author can name
this if they care to" convention).

Payload (JSON, QoS 0, matching this project's "no authentication, no extra
protocol machinery beyond what's needed to teach the concept" posture for
every real protocol built so far):
    {"value": <float>, "unit": "<string>", "timestamp": "<ISO8601>"}

Environment variables:
    DEVICE_ID             — node identifier string, used in logging and the
                             default MQTT topic
    DEVICE_CATEGORY        — logged at startup for Docker Compose traceability
    MQTT_BROKER_IP         — Docker network IP of the wired iot-gateway
                             (compose-generator.ts injects this from canvas
                             edges — see MQTT_BROKER_IP in compose-generator.ts).
                             Empty/unset means the sensor was placed but not
                             wired to a gateway yet; the process logs a clear
                             warning and idles rather than crash-looping.
    MQTT_BROKER_PORT       — broker TCP port (default 1883, the IANA-assigned
                             standard MQTT port)
    SENSOR_KIND            — mirrors SensorConfig.kind (informational/logging)
    SENSOR_WAVEFORM        — sine | random | sawtooth | square | constant
    SENSOR_MIN_VALUE       — bottom of the simulated engineering range
    SENSOR_MAX_VALUE       — top of the simulated engineering range
    SENSOR_UNITS           — engineering units string included in the payload
    SENSOR_NOISE_PERCENT   — Gaussian noise added on top of the waveform, as a
                             percentage of the full range (0 = clean)
    SENSOR_SAMPLE_RATE_MS  — publish interval in milliseconds (default 1000)
    SENSOR_TAG_NAME        — optional MQTT topic override (mirrors
                             SensorConfig.tagName); falls back to DEVICE_ID

Protocol reference: MQTT Version 3.1.1 (OASIS Standard).
Library version: paho-mqtt 2.1.0 (client mode).
"""

import json
import logging
import math
import os
import random
import time
from datetime import datetime, timezone

import paho.mqtt.client as mqtt

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ics-iiot-sensor")

DEVICE_ID = os.getenv("DEVICE_ID", "iiot-1")
CATEGORY = os.getenv("DEVICE_CATEGORY", "iiot-sensor")

BROKER_IP = os.getenv("MQTT_BROKER_IP", "").strip()
BROKER_PORT = int(os.getenv("MQTT_BROKER_PORT", "1883"))

SENSOR_KIND = os.getenv("SENSOR_KIND", "temperature")
SENSOR_WAVEFORM = os.getenv("SENSOR_WAVEFORM", "sine")
SENSOR_MIN_VALUE = float(os.getenv("SENSOR_MIN_VALUE", "0"))
SENSOR_MAX_VALUE = float(os.getenv("SENSOR_MAX_VALUE", "100"))
SENSOR_UNITS = os.getenv("SENSOR_UNITS", "")
SENSOR_NOISE_PERCENT = float(os.getenv("SENSOR_NOISE_PERCENT", "5"))
SENSOR_SAMPLE_RATE_MS = int(os.getenv("SENSOR_SAMPLE_RATE_MS", "1000"))

TOPIC = f"otforge/{os.getenv('SENSOR_TAG_NAME', '').strip() or DEVICE_ID}/value"


def sensor_value_at(t: float) -> float:
    """
    Computes the raw engineering value at elapsed time t (seconds), before
    noise, per SENSOR_WAVEFORM — identical math to containers/modbus/
    server.py's _sensor_value_at():
      sine     — smooth oscillation between min and max, period 60 s
      random   — white noise bounded by min/max (ignores t)
      sawtooth — linear ramp 0->1 every 60 s then reset
      square   — two-state, half-period 30 s
      constant — fixed at (min + max) / 2
    """
    lo, hi = SENSOR_MIN_VALUE, SENSOR_MAX_VALUE
    mid, span = (lo + hi) / 2.0, (hi - lo) / 2.0
    period = 60.0

    if SENSOR_WAVEFORM == "sine":
        return mid + span * math.sin(2 * math.pi * t / period)
    if SENSOR_WAVEFORM == "random":
        return random.uniform(lo, hi)
    if SENSOR_WAVEFORM == "sawtooth":
        return lo + (hi - lo) * ((t % period) / period)
    if SENSOR_WAVEFORM == "square":
        return hi if (t % period) < period / 2 else lo
    return mid  # constant


def main() -> None:
    log.info(
        "IIoT sensor starting -- id=%s  category=%s  kind=%s  waveform=%s  "
        "range=[%.2f, %.2f]  rate=%dms  topic=%s",
        DEVICE_ID, CATEGORY, SENSOR_KIND, SENSOR_WAVEFORM,
        SENSOR_MIN_VALUE, SENSOR_MAX_VALUE, SENSOR_SAMPLE_RATE_MS, TOPIC,
    )

    if not BROKER_IP:
        log.warning(
            "No MQTT_BROKER_IP configured -- this sensor was placed but not "
            "wired to an iot-gateway. Idling (no publishes) rather than "
            "crash-looping; wire an edge to a gateway and restart."
        )
        while True:
            time.sleep(3600)

    client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=DEVICE_ID)

    def on_connect(_client, _userdata, _flags, reason_code, _properties=None):
        if reason_code == 0:
            log.info("Connected to broker %s:%d", BROKER_IP, BROKER_PORT)
        else:
            log.warning("Connect failed: %s", reason_code)

    def on_disconnect(_client, _userdata, _flags, reason_code, _properties=None):
        log.warning("Disconnected from broker (reason=%s) -- paho will auto-reconnect", reason_code)

    client.on_connect = on_connect
    client.on_disconnect = on_disconnect

    # No authentication configured — matches every other real protocol server
    # in this project (Modbus, DNP3, BACnet, EtherNet/IP, PROFINET, C37.118):
    # the teaching point is the protocol's own lack of built-in security, not
    # a simulator shortcut. A future MQTT attack tutorial can exploit this
    # exactly like the existing tutorials exploit their own protocols' lack
    # of authentication.
    client.connect_async(BROKER_IP, BROKER_PORT, keepalive=30)
    client.loop_start()

    dt = SENSOR_SAMPLE_RATE_MS / 1000.0
    full_range = SENSOR_MAX_VALUE - SENSOR_MIN_VALUE
    t = 0.0
    tick = 0
    try:
        while True:
            time.sleep(dt)
            t += dt
            value = sensor_value_at(t)
            if SENSOR_NOISE_PERCENT > 0:
                value += random.gauss(0.0, full_range * SENSOR_NOISE_PERCENT / 100.0)
            value = max(SENSOR_MIN_VALUE, min(SENSOR_MAX_VALUE, value))

            payload = json.dumps({
                "value": round(value, 3),
                "unit": SENSOR_UNITS,
                "timestamp": datetime.now(timezone.utc).isoformat(),
            })
            client.publish(TOPIC, payload, qos=0)

            tick += 1
            if tick % 30 == 0:
                log.info("[%s] t=%.0fs value=%.3f%s", TOPIC, t, value,
                          f" {SENSOR_UNITS}" if SENSOR_UNITS else "")
    except KeyboardInterrupt:
        pass
    finally:
        client.loop_stop()
        client.disconnect()


if __name__ == "__main__":
    main()

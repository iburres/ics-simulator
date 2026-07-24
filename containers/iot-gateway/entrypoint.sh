#!/bin/sh
set -e

echo "[ics-iot-gateway] Device=${DEVICE_ID}  category=${DEVICE_CATEGORY}  mqtt_port=${MQTT_PORT}"

# Mosquitto runs backgrounded; the Python sidecar execs as the foreground
# (PID 1) process so the container's lifecycle ties to the sidecar's health.
# Same backgrounded-process-plus-foreground-exec shape already used in
# containers/attack-base/entrypoint.sh's plc_init poller. Both processes'
# stdout share this container's stdout stream (mosquitto.conf sets
# log_dest stdout), so `docker logs` shows real broker activity interleaved
# with the sidecar's own log lines.
echo "[ics-iot-gateway] Starting Mosquitto broker on 0.0.0.0:${MQTT_PORT} (anonymous access)..."
mosquitto -c /etc/mosquitto/mosquitto.conf &

# Give the broker a moment to bind its listening socket before the sidecar's
# first connection attempt — avoids a guaranteed-fail first try on every
# container start (the sidecar's own paho-mqtt client will still retry/
# reconnect on its own after this, this just avoids the noisy first failure).
sleep 1

exec python3 /app/sidecar.py

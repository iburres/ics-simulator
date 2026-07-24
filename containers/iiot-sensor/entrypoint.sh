#!/bin/sh
set -e

echo "[ics-iiot-sensor] Device=${DEVICE_ID}  category=${DEVICE_CATEGORY}  broker=${MQTT_BROKER_IP:-<unset>}:${MQTT_BROKER_PORT}"

exec python3 /app/server.py

#!/bin/sh
set -e

echo "[ics-pmu] Device=${DEVICE_ID}  category=${DEVICE_CATEGORY}  port=${PMU_PORT}  idcode=${PMU_IDCODE}"

exec python3 /app/server.py

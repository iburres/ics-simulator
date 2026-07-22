#!/bin/sh
# entrypoint.sh — Container startup for OTForge process-sim (Phase 11).
# Logs the active process type and configuration before handing off to sim.py.
set -e

echo "[ics-process-sim] Device=${DEVICE_ID}  process=${PROCESS_TYPE}  port=${MODBUS_PORT}"

case "$PROCESS_TYPE" in
  water-tank)
    echo "[ics-process-sim] Tank=${TANK_VOLUME_L}L  area=${TANK_AREA_M2}m2  " \
         "pump_max=${PUMP_FLOW_MAX_LPM}L/min  valve_max=${VALVE_FLOW_MAX_LPM}L/min  " \
         "initial=${INITIAL_LEVEL_PCT}%"
    ;;
  pipeline)
    echo "[ics-process-sim] Pipeline vol=${PIPELINE_VOLUME_L}L  pump_max=${PIPELINE_PUMP_MAX_LPM}L/min"
    ;;
  generator)
    echo "[ics-process-sim] Generator rated=${GENERATOR_RATED_MW}MW  " \
         "H=${GENERATOR_INERTIA_H}s  f_base=${GENERATOR_FREQ_BASE}Hz"
    ;;
  generic)
    echo "[ics-process-sim] Generic signal generator mode"
    ;;
  batch-reactor)
    echo "[ics-process-sim] Batch reactor vessel=${TANK_VOLUME_L}L  area=${TANK_AREA_M2}m2  " \
         "charge_max=${VALVE_FLOW_MAX_LPM}L/min  heater=${HEATER_RATE_C_PER_S}C/s  " \
         "cooling=${COOLING_RATE_C_PER_S}C/s"
    ;;
  *)
    echo "[ics-process-sim] WARNING: unknown PROCESS_TYPE='${PROCESS_TYPE}' — defaulting to water-tank"
    ;;
esac

exec python3 /app/sim.py

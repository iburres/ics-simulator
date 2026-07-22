#!/bin/bash
# containers/openplc/entrypoint.sh — OpenPLC Runtime container startup script.
#
# Environment variables consumed:
#   DEVICE_ID            — Canvas node ID of this PLC device (e.g., "plc-1")
#   DEVICE_CATEGORY      — Always "plc" for this container image
#   OPENPLC_PORT         — TCP port for the OpenPLC web interface (default: 8080)
#   MODBUS_PORT          — TCP port for the Modbus/TCP slave (default: 502)
#   INITIAL_PROGRAM_B64  — (Optional) Base64-encoded IEC 61131-3 Structured Text
#                          source. When set, the program is decoded to a .st file
#                          and uploaded to the OpenPLC runtime at startup so the
#                          PLC begins executing the user's scenario program
#                          immediately. Injected by compose-generator.ts when
#                          the scenario device has a plcProgram defined.
#   PLC_VAR_COUNT        — (Optional) Number of protocol-mapped variables in the
#                          program. Informational — logged at startup.
#   ENIP_PORT            — EtherNet/IP CIP TCP port (default: 44818). OpenPLC
#                          Runtime v3 Linux driver always binds this port; the env
#                          var is logged here and used by the scenario for FUXA/
#                          pycomm3 configuration.
#   ENIP_SLOT            — Backplane slot number for this controller (default: 0).
#   PROCESS_SIM_IP       — (Optional) Docker network IP of the connected process-unit
#                          container. When set, entrypoint generates a single-device
#                          Modbus TCP mbconfig.cfg so the OpenPLC Modbus master polls
#                          the physics simulator (%IW100 = LEVEL_PV) and drives its
#                          actuators (%QX100.0-3 = pump/valve commands). Injected by
#                          compose-generator.ts when a PLC↔process-unit edge exists.
#   SIS_MBCONFIG_B64     — (Optional, safety-plc only) Base64-encoded, fully-built
#                          mbconfig.cfg content for M-out-of-N safety voting — one
#                          Modbus TCP master device per redundant sensor wired
#                          directly to this safety-plc on the canvas, each reporting
#                          at %IW100, %IW101, %IW102... in wiring order. Takes
#                          precedence over PROCESS_SIM_IP if both are somehow set
#                          (not a real scenario compose-generator.ts produces today —
#                          see plc-program-gen.ts's buildSafetyVotingProgram for the
#                          matching ST logic that reads these registers). Unlike
#                          PROCESS_SIM_IP's single-device case, this file is built
#                          entirely in TypeScript (compose-generator.ts) rather than
#                          templated here in bash, so it's unit-testable the same way
#                          INITIAL_PROGRAM_B64 already is.

set -e

echo "[ics-openplc] Device=${DEVICE_ID}  category=${DEVICE_CATEGORY}  web=${OPENPLC_PORT}  modbus=${MODBUS_PORT}  enip=${ENIP_PORT:-44818}  slot=${ENIP_SLOT:-0}"

cd /opt/openplc

# ── Pre-load and compile Structured Text program ──────────────────────────────
#
# If INITIAL_PROGRAM_B64 is set, decode the base64 string to a .st file,
# register it in the OpenPLC database, and COMPILE it to a native binary so
# the runtime executes it immediately on startup.
#
# IMPORTANT: webserver.py does NOT auto-compile from source at startup — it
# only spawns a pre-built binary at webserver/core/openplc. Writing the ST
# file and setting DB flags is not enough; we must invoke compile_program.sh
# here so the binary exists before start_openplc.sh is called.
#
# The ST file is named after the device ID so it appears correctly in the
# OpenPLC web interface program list for debugging purposes.

if [ -n "${INITIAL_PROGRAM_B64}" ]; then
  PROGRAM_DIR="/opt/openplc/webserver/st_files"
  PROGRAM_FILE="${PROGRAM_DIR}/${DEVICE_ID}.st"
  PROG_BASENAME="${DEVICE_ID}.st"

  echo "[ics-openplc] Decoding INITIAL_PROGRAM_B64 → ${PROGRAM_FILE}"
  echo "${INITIAL_PROGRAM_B64}" | base64 -d > "${PROGRAM_FILE}"

  if [ -n "${PLC_VAR_COUNT}" ]; then
    echo "[ics-openplc] Program has ${PLC_VAR_COUNT} variable binding(s)"
  fi

  # OpenPLC Runtime v3 uses three mechanisms to auto-start a program:
  #
  #   1. active_program   — plain-text file under webserver/ containing the
  #                         ST filename.  webserver.py reads this at startup
  #                         to look up the program record in the DB.
  #
  #   2. Programs table   — SQLite row with columns (File, Name, Description).
  #                         webserver.py queries this by filename to get the
  #                         human-readable name/description for the UI.
  #
  #   3. Start_run_mode   — Settings row; when 'true', webserver.py calls
  #                         openplc_runtime.start_runtime() automatically
  #                         and the Modbus/TCP + EtherNet/IP servers bind.
  #
  # All three must be set; updating only one is not sufficient.

  DB="/opt/openplc/webserver/openplc.db"

  if command -v sqlite3 &>/dev/null; then
    # Upsert into Programs so webserver.py can look up the project metadata
    sqlite3 "${DB}" \
      "INSERT OR REPLACE INTO Programs (Name, Description, File, Date_upload) \
       VALUES ('${DEVICE_ID}', 'Auto-loaded program for ${DEVICE_ID}', \
               '${PROG_BASENAME}', strftime('%s','now'));" 2>/dev/null || true

    # Set Start_run_mode so the runtime launches automatically at startup
    sqlite3 "${DB}" \
      "UPDATE Settings SET Value='true' WHERE Key='Start_run_mode';" 2>/dev/null || true

    echo "[ics-openplc] Registered '${PROG_BASENAME}' in DB with auto-start enabled"
  else
    echo "[ics-openplc] sqlite3 not found — DB registration skipped"
  fi

  # Update the active_program pointer that webserver.py reads on startup
  echo "${PROG_BASENAME}" > /opt/openplc/webserver/active_program
  echo "[ics-openplc] active_program → ${PROG_BASENAME}"

  # ── Compile the ST program to a native binary ──────────────────────────────
  #
  # Mirrors the steps in openplc.py compile_program():
  #   1. Copy core/debug.blank → core/debug.cpp  (required stub; compile_program.sh
  #      links against it and will fail if the file is missing or stale)
  #   2. Call scripts/compile_program.sh <basename>
  #      — iec2c (MatIEC) converts the ST source to ANSI C
  #      — glue_generator binds IEC variable addresses to hardware memory
  #      — GCC links everything into the core/openplc executable
  #
  # scripts/compile_program.sh must be called from /opt/openplc/webserver/
  # because it does its own 'cd scripts' internally to read the openplc_platform
  # and openplc_driver config files. Compilation takes 30–90 s on first run.
  echo "[ics-openplc] Compiling '${PROG_BASENAME}' — MatIEC + GCC (30-90 s)..."
  cd /opt/openplc/webserver
  cp -f core/debug.blank core/debug.cpp
  if bash scripts/compile_program.sh "${PROG_BASENAME}"; then
    echo "[ics-openplc] Compilation succeeded — core/openplc binary ready"
  else
    echo "[ics-openplc] ERROR: Compilation failed — runtime will start without a program"
  fi
  cd /opt/openplc

else
  echo "[ics-openplc] No INITIAL_PROGRAM_B64 set — starting with no program loaded"
fi

# ── Generate mbconfig.cfg ─────────────────────────────────────────────────────
#
# modbus_master.cpp opens mbconfig.cfg at runtime to discover external slave
# devices (OpenPLC acting as Modbus master). When the file is absent it logs:
#   "Skipping configuration of Slave Devices (mbconfig.cfg file not found)"
#
# If PROCESS_SIM_IP is set (injected by compose-generator when this PLC is
# connected to a process-unit in the scenario), configure a single Modbus TCP
# slave pointing at the physics simulator so the ST program can read PVs
# (%IW100+) and drive commands (%QX100.x) via the Modbus master.
#
# Sized for the richest consumer (batch-controller, 6 coils + 5 input
# registers) rather than per-category — plain plc/safety-plc/generator/
# pipeline scenarios simply read/write the extra positions and ignore them
# (process-sim's coil/register blocks are always 256 wide, so this is safe).
#
# Address mapping (from modbus_master.cpp updateBuffersIn_MB / updateBuffersOut_MB):
#   Coils_Start=0, Coils_Size=6              → bool_output[100][0..5] = %QX100.0..100.5
#   Holding_Registers_Read_Start=0, Size=5   → int_input[100..104]   = %IW100..%IW104
#
# If SIS_MBCONFIG_B64 is set (safety-plc with 1+ redundant sensors wired on
# the canvas — see compose-generator.ts), it already IS the complete file
# content, built and unit-tested in TypeScript; just decode and write it,
# matching the INITIAL_PROGRAM_B64 decode pattern above. Checked first so it
# takes precedence over PROCESS_SIM_IP in the (not currently scenario-
# generated) case both are somehow set.
#
# Otherwise, if PROCESS_SIM_IP is NOT set, write a zero-device stub to
# silence the warning. webserver.py regenerates this file whenever slaves
# are added via the UI, so the pre-created stub is always safe.
if [ -n "${SIS_MBCONFIG_B64}" ]; then
  echo "${SIS_MBCONFIG_B64}" | base64 -d > /opt/openplc/webserver/mbconfig.cfg
  echo "[ics-openplc] mbconfig.cfg → safety voting config decoded from SIS_MBCONFIG_B64"
elif [ -n "${PROCESS_SIM_IP}" ]; then
  cat > /opt/openplc/webserver/mbconfig.cfg << EOF
Num_Devices = "1"
Polling_Period = "100"
Timeout = "1000"

device0.name = "process-unit"
device0.protocol = "TCP"
device0.slave_id = "1"
device0.address = "${PROCESS_SIM_IP}"
device0.IP_Port = "502"
device0.RTU_Baud_Rate = "0"
device0.RTU_Parity = "0"
device0.RTU_Data_Bits = "0"
device0.RTU_Stop_Bits = "0"
device0.RTU_TX_Pause = "0"

device0.Discrete_Inputs_Start = "0"
device0.Discrete_Inputs_Size = "0"
device0.Coils_Start = "0"
device0.Coils_Size = "6"
device0.Input_Registers_Start = "0"
device0.Input_Registers_Size = "0"
device0.Holding_Registers_Read_Start = "0"
device0.Holding_Registers_Read_Size = "5"
device0.Holding_Registers_Start = "0"
device0.Holding_Registers_Size = "0"
EOF
  echo "[ics-openplc] mbconfig.cfg → 1 slave device (process-unit @ ${PROCESS_SIM_IP}:502)"
else
  cat > /opt/openplc/webserver/mbconfig.cfg <<'EOF'
Num_Devices = "0"
Polling_Period = "100"
Timeout = "1000"
EOF
  echo "[ics-openplc] mbconfig.cfg → 0 slave devices (standalone mode)"
fi

# ── Start OpenPLC Runtime ──────────────────────────────────────────────────────
# start_openplc.sh changes to /opt/openplc/webserver, activates the .venv, and
# launches webserver.py (Flask). On startup webserver.py checks Start_run_mode;
# when true it calls start_runtime() which exec's the pre-compiled binary at
# webserver/core/openplc. That binary serves:
#   - Modbus/TCP slave  on port ${MODBUS_PORT}  (502)
#   - EtherNet/IP CIP   on port ${ENIP_PORT:-44818}
#   - S7comm (snap7)    on port 102
# The binary must already exist (built above) before webserver.py starts.
exec /opt/openplc/start_openplc.sh "$@"

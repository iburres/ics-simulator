#!/bin/bash
# entrypoint.sh — Zeek network monitor startup for the otforge-zeek container.
#
# Reads script configuration injected by compose-generator.ts and starts Zeek
# in passive analysis mode on the host's simulation bridge interfaces.
#
# Environment variables:
#   DEVICE_ID     — Device node ID from the scenario (logged on start)
#   ZEEK_IFACE    — Explicit single interface to monitor, bypassing bridge
#                   auto-detection (default: auto-detect, see below)
#   ZEEK_SCRIPTS  — Comma-separated script filenames to load from the Zeek site dir.
#                   e.g. "modbus.zeek,dnp3.zeek"
#                   When empty, defaults to "modbus.zeek,dnp3.zeek".
#                   Scripts must exist under /opt/zeek/share/zeek/site/.
#                   The bundled ics-monitor.zeek is always loaded via local.zeek.
#
# Zeek operates passively: it observes a copy of all traffic but does not block or
# modify packets. Log files (conn.log, modbus.log, dnp3.log, etc.) are written to
# /var/log/zeek/ (a named volume in the compose file, consumed by Loki in Phase 6).
#
# Capture topology: like Suricata, this container runs with network_mode: host
# (see compose-generator.ts) so it can open packet sockets directly on the
# host-side br-XXXX Linux bridges that Docker creates for each simulation network.
# A container's own veth in promiscuous mode does NOT see sibling-container
# unicast traffic — the bridge only forwards frames to the port that owns the
# destination MAC. Only the host-side bridge itself sees every frame on the
# segment. Zeek previously joined ot-net/internet-dmz-net/attacker-net as a
# regular multi-homed container and enabled promisc on whichever single veth it
# found first — that missed most cross-container traffic and explains why DNP3/
# Modbus logs were empty or inconsistent for some students. This mirrors the fix
# already applied to Suricata.

set -e

SCRIPTS="${ZEEK_SCRIPTS:-modbus.zeek,dnp3.zeek}"

# ── Select and prepare the capture interfaces ───────────────────────────────────
IFACES=()

if [ -n "${ZEEK_IFACE:-}" ]; then
    # Explicit single-interface override (useful for unit tests or non-host-mode deployments)
    ip link set "$ZEEK_IFACE" promisc on 2>/dev/null \
        && echo "[ics-zeek] Promiscuous mode enabled on ${ZEEK_IFACE}" \
        || echo "[ics-zeek] Warning: could not set promisc on ${ZEEK_IFACE}"
    IFACES=("$ZEEK_IFACE")
else
    # Running in host network mode: detect Docker bridge interfaces (br-XXXX) that
    # carry simulation traffic, exactly as containers/suricata/entrypoint.sh does.
    for candidate in $(ls /sys/class/net/ 2>/dev/null | sort); do
        if [ -d "/sys/class/net/${candidate}/bridge" ] 2>/dev/null; then
            if ip addr show "$candidate" 2>/dev/null | grep -qE 'inet 10\.200\.'; then
                echo "[ics-zeek] Found simulation bridge: ${candidate}"
                IFACES+=("$candidate")
            fi
        fi
    done
    if [ ${#IFACES[@]} -eq 0 ]; then
        # Fallback: no bridge interfaces found — may be running outside host-network mode.
        echo "[ics-zeek] Warning: no br-XXXX bridge interfaces found, falling back to veth scan"
        for candidate in $(ls /sys/class/net/ 2>/dev/null | grep -v lo | sort); do
            if ip addr show "$candidate" 2>/dev/null | grep -qE 'inet 10\.'; then
                ip link set "$candidate" promisc on 2>/dev/null
                IFACES+=("$candidate")
            fi
        done
    fi
    if [ ${#IFACES[@]} -eq 0 ]; then
        echo "[ics-zeek] Warning: no suitable interface found, falling back to eth0"
        IFACES=("eth0")
    fi
fi

echo "[ics-zeek] Device=${DEVICE_ID}  interfaces=${IFACES[*]}"
echo "[ics-zeek] Requested scripts: ${SCRIPTS}"

# ── Resolve requested scripts to absolute paths ─────────────────────────────────
# Each script name in ZEEK_SCRIPTS is resolved against the Zeek site directory.
# Non-existent scripts are skipped with a warning rather than failing the container.
SITE_DIR="/usr/local/zeek/share/zeek/site"
EXTRA_ARGS=()

for script in $(echo "$SCRIPTS" | tr ',' ' '); do
    script_clean=$(echo "$script" | tr -d '[:space:]')
    [ -z "$script_clean" ] && continue

    script_path="${SITE_DIR}/${script_clean}"
    if [ -f "$script_path" ]; then
        EXTRA_ARGS+=("$script_path")
        echo "[ics-zeek] Loading script: ${script_clean}"
    else
        # Script not found — this is expected if the scenario enables a script that
        # hasn't been bundled into the image yet. Log and continue gracefully.
        echo "[ics-zeek] Warning: script not found, skipping: ${script_clean}"
    fi
done

# ── Start Zeek ──────────────────────────────────────────────────────────────────
# `zeek -i` writes all log files (conn.log, modbus.log, etc.) to its WORKING
# DIRECTORY — there is no --logdir flag in standalone mode (zeekctl handles that
# in managed deployments).
#
# Unlike Suricata (whose AF_PACKET engine natively multiplexes many interfaces
# inside one process), Zeek's standalone CLI rejects more than one -i: "Only a
# single interface option (-i) is allowed." So multi-bridge coverage means one
# Zeek worker process per detected interface, each in its own subdirectory so
# their same-named log files (conn.log, dnp3.log, ...) don't collide. Promtail's
# __path__ glob (grafana-provisioning.ts) picks up every worker's logs.
LOG_DIR="/var/log/zeek"
mkdir -p "${LOG_DIR}"
echo "[ics-zeek] Starting ${#IFACES[@]} Zeek worker(s), one per interface..."

PIDS=()
# Forward SIGTERM/SIGINT (`docker stop`) to every worker so the container shuts
# down promptly instead of waiting out Docker's kill timeout.
trap 'echo "[ics-zeek] Stopping workers..."; kill "${PIDS[@]}" 2>/dev/null; wait' TERM INT

for iface in "${IFACES[@]}"; do
    iface_dir="${LOG_DIR}/${iface}"
    mkdir -p "${iface_dir}"
    # -C/--no-checksums: Docker veth/bridge interfaces carry checksum-offloaded
    # traffic — locally-generated packets often have unfilled or "invalid" L4
    # checksums that only get computed by the NIC (or, here, never at all since
    # there's no physical NIC). Without -C, Zeek discards nearly every packet as
    # checksum-invalid, so connections are seen but never fully parsed (visible
    # as conn.log entries stuck in state OTH with no application-layer log
    # lines). Suricata does not need an equivalent flag — af-packet capture
    # trusts the kernel's own checksum-validity flag instead of recomputing it.
    (cd "${iface_dir}" && exec zeek -C -i "${iface}" "${SITE_DIR}/local.zeek" "${EXTRA_ARGS[@]}") &
    PIDS+=("$!")
    echo "[ics-zeek] Worker for ${iface} started (pid $!), logs in ${iface_dir}"
done

wait

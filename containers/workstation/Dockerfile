# ── Build stage: compile the IEC 61850 MMS client against libiec61850 ────────
# Same client copied into the attack-machine image. MMS is a full ISO stack
# (ACSE/Presentation/Session over BER-encoded ASN.1), not a reasonable
# one-file hand-rolled implementation the way the Modbus/DNP3 scripts below
# are, so this workstation talks to the real IED using the same compiled
# client the "attack" uses — the only difference is which network the caller
# runs from.
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

FROM ubuntu:22.04

ARG DEBIAN_FRONTEND=noninteractive

# ── Layer 0: Security baseline — upgrade all base packages ────────────────────
# Ubuntu 22.04 base image packages are frozen at the image publish date.
# Running apt-get upgrade here ensures every subsequent layer starts from a
# fully-patched baseline. Fixes CVE-2026-45447 (OpenSSL heap use-after-free
# in PKCS7_verify, fixed in openssl/libssl 3.0.2-0ubuntu1.25).
RUN apt-get update && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 1: Core system + desktop environment ─────────────────────────────────
# Firefox is intentionally NOT installed via `apt install firefox`.
# On Ubuntu 22.04, that package is a snap stub — it tries to exec `snap run firefox`
# at runtime, but snapd is not available inside Docker containers, so every Firefox
# launch silently fails with no error message.
#
# Fix: use Mozilla's own official apt repository (packages.mozilla.org).
# curl downloads the repository signing key directly — no add-apt-repository and
# no gpg-agent dependency, both of which fail in minimal Docker base images.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xfce4 xfce4-terminal xfce4-taskmanager \
    dbus-x11 x11-xserver-utils xdg-utils \
    tigervnc-standalone-server \
    ca-certificates curl \
    && install -d -m 0755 /etc/apt/keyrings \
    && curl -fsSL https://packages.mozilla.org/apt/repo-signing-key.gpg \
       -o /etc/apt/keyrings/packages.mozilla.org.asc \
    && echo "deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main" \
       > /etc/apt/sources.list.d/mozilla.list \
    && printf 'Package: *\nPin: origin packages.mozilla.org\nPin-Priority: 1000\n' \
       > /etc/apt/preferences.d/mozilla \
    && apt-get update && apt-get install -y --no-install-recommends firefox \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 2: Network and protocol analysis tools ───────────────────────────────
# Wireshark runs as root inside Docker — no setuid/group dance needed.
# nmap includes the ICS NSE scripts (enip-info, modbus-discover, bacnet-info).
RUN apt-get update && apt-get install -y --no-install-recommends \
    wireshark \
    tshark \
    nmap \
    netcat-openbsd \
    iputils-ping \
    iproute2 \
    tcpdump \
    curl \
    wget \
    && rm -rf /var/lib/apt/lists/*

# ── Layer 3: Python ICS protocol libraries ────────────────────────────────────
# Same protocol libraries as the attack machine so scripts are portable;
# uses the latest pymodbus (device_id= API, consistent with attack-base).
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip \
    && rm -rf /var/lib/apt/lists/* \
    && pip3 install --no-cache-dir \
        pymodbus \
        asyncua \
        bacpypes3 \
        dnp3-python \
        python-snap7

# ── Layer 4: OpenPLC Editor (IEC 61131-3 PLC programming IDE) ─────────────────
#
# The OpenPLC Editor is a wxPython-based desktop IDE for writing PLC programs
# in Ladder Diagram (LD), Function Block Diagram (FBD), Sequential Function
# Chart (SFC), Instruction List (IL), and Structured Text (ST). Students write
# here, then upload the saved project to the OpenPLC Runtime via its web UI.
#
# wxPython must be 4.1.0+ for wx.svg support. The Ubuntu apt package
# python3-wxgtk4.0 is version 4.0.7 and is missing that module, causing
# Beremiz.py to crash at import. We use the pre-built wheel from the official
# wxPython extras repo instead (fast — no source compilation needed).
#
# GDK_BACKEND=x11 is set in the launcher script — required for GTK3 apps
# to render correctly inside a VNC X session (LabShock uses the same fix).
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgtk-3-0 \
    libglib2.0-0 \
    libgdk-pixbuf2.0-0 \
    libnotify4 \
    libsdl2-2.0-0 \
    libxtst6 \
    libsm6 \
    libpcre2-32-0 \
    git \
    g++ \
    make \
    autoconf \
    automake \
    bison \
    flex \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir \
    -f https://extras.wxpython.org/wxPython4/extras/linux/gtk3/ubuntu-22.04/ \
    "wxPython==4.2.0" \
    && pip3 install --no-cache-dir \
    "lxml" \
    matplotlib \
    zeroconf \
    pyserial \
    pypubsub \
    Pyro5 \
    attrdict3 \
    Jinja2 \
    future

RUN git clone --depth 1 \
       https://github.com/thiagoralves/OpenPLC_Editor.git \
       /opt/openplc-editor \
    && cd /opt/openplc-editor \
    && git submodule update --init --depth 1 editor \
    && git clone --depth 1 https://github.com/thiagoralves/matiec \
       /opt/openplc-editor/matiec \
    && cd /opt/openplc-editor/matiec \
    && autoreconf -f -i \
    && ./configure --disable-dependency-tracking \
    && make \
    && cd /opt/openplc-editor \
    && rm -f editor/arduino/bin/arduino-cli* \
    && test -f editor/Beremiz.py \
    && printf '#!/bin/bash\nexport GDK_BACKEND=x11\ncd /opt/openplc-editor/editor\nexec python3 Beremiz.py "$@"\n' \
       > /usr/local/bin/openplc-editor \
    && chmod +x /usr/local/bin/openplc-editor

# ── Layer 5: noVNC WebSocket bridge ───────────────────────────────────────────
RUN pip3 install --no-cache-dir websockify \
    && mkdir -p /opt/novnc \
    && curl -fsSL https://github.com/novnc/noVNC/archive/refs/tags/v1.5.0.tar.gz \
       | tar -xz --strip-components=1 -C /opt/novnc

# ── Layer 6: Protocol sample scripts ──────────────────────────────────────────
# Pre-placed on the Desktop so students can run them without typing in noVNC.
COPY scripts/ /root/Desktop/Protocols/
RUN chmod +x /root/Desktop/Protocols/*.py 2>/dev/null || true

# IEC 61850 MMS client — compiled binary only, no build toolchain in the final image.
COPY --from=iec61850-build \
    /src/libiec61850/examples/otforge-client/iec61850-client \
    /opt/otforge/iec61850-client

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV DEVICE_ID=workstation-1 \
    DEVICE_CATEGORY=engineering-workstation \
    DISPLAY=:1

# noVNC WebSocket bridge — same port as attack-base for consistency
EXPOSE 6080

ENTRYPOINT ["/entrypoint.sh"]

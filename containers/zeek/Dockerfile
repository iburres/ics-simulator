FROM zeek/zeek:latest

# Upgrade all base OS packages to pull in the latest security patches.
# Trivy scan found 17 CRITICAL and 52 HIGH CVEs in the upstream zeek/zeek:latest
# image (libgnutls, Python 3.13, Perl, node-undici, etc.) -- all fixed by simply
# running apt-get upgrade against the Debian package repos.
# --no-install-recommends intentionally omitted: security upgrades should pull
# in recommended packages so that patch coverage is complete.
# Fixes CVE-2026-45447 (openssl heap use-after-free, libssl3t64 3.5.6-1~deb13u2).
#
# SECURITY_REFRESH busts this layer's build cache so a rebuild re-runs the
# upgrade against the *current* Debian repos rather than reusing a months-old
# cached layer. Bump the date whenever a newly published security update needs
# to be pulled. 2026-07-06: libssh2 1.11.1-1+deb13u1 fixes CVE-2026-55200
# (CRITICAL out-of-bounds write), CVE-2026-55199 (HIGH DoS), and CVE-2026-7598
# — none of which were in the repos when this image was last built (2026-06-29).
ARG SECURITY_REFRESH=2026-07-06
RUN echo "security-refresh: ${SECURITY_REFRESH}" \
    && apt-get update && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/*

# iproute2 provides the `ip` binary entrypoint.sh needs to enumerate the host's
# br-XXXX Docker bridge interfaces and their addresses. zeek/zeek:latest does not
# include it by default (unlike jasonish/suricata:latest, which does) — without
# it, `ip addr show`/`ip link set promisc` fail silently (stderr is discarded)
# and bridge auto-detection always falls through to a hardcoded "eth0", which is
# never a real bridge in host network mode. This was the actual root cause of
# Lab 03's empty/inconsistent DNP3 logs.
RUN apt-get update && apt-get install -y --no-install-recommends iproute2 \
    && rm -rf /var/lib/apt/lists/*

# ICS protocol monitoring scripts. ics-monitor.zeek (shared module: Notice types,
# zone classification, generic connection summary) is always loaded via local.zeek.
# modbus.zeek and dnp3.zeek are optional per-protocol analyzers — bundled here so
# they exist under the site dir, but only loaded when the scenario's ZEEK_SCRIPTS
# selection (entrypoint.sh) names them explicitly.
COPY ics-monitor.zeek /usr/local/zeek/share/zeek/site/ics-monitor.zeek
COPY modbus.zeek /usr/local/zeek/share/zeek/site/modbus.zeek
COPY dnp3.zeek /usr/local/zeek/share/zeek/site/dnp3.zeek

# Load the always-on shared script from the site policy
RUN echo "@load ics-monitor" >> /usr/local/zeek/share/zeek/site/local.zeek

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# No default ZEEK_IFACE here — the entrypoint treats a non-empty ZEEK_IFACE as an
# explicit single-interface override that skips br-XXXX bridge auto-detection
# entirely. A baked-in "eth0" default silently disabled auto-detection on every
# run (this was the actual root cause of Lab 03's DNP3 log gap: Zeek always
# monitored a hardcoded "eth0" — whichever network Docker happened to assign
# that name to — never the host-side bridges, regardless of the entrypoint
# logic added to look for them).
ENV DEVICE_ID=zeek-1

ENTRYPOINT ["/entrypoint.sh"]

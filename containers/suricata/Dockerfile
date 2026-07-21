FROM jasonish/suricata:latest

# CVE-2026-58016 (glib2, HIGH) is suppressed in the root .trivyignore — it's
# baked into this upstream base image (no apt/dnf layer of our own to patch
# it with) and isn't fixed in jasonish/suricata:latest yet as of 2026-07-21.

# ICS/OT-specific rules — loaded by the rule-files list in otforge.yaml
COPY ics-rules.rules /etc/suricata/rules/otforge.rules

# Suricata overlay config — sets HOME_NET, enables Modbus/DNP3 decoders,
# configures EVE JSON output, and lists rule files. The entrypoint passes
# -c /etc/suricata/otforge.yaml so this file must be at exactly this path.
COPY suricata.yaml /etc/suricata/otforge.yaml

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# DEVICE_ID is overridden at runtime via compose environment.
# SURICATA_IFACE is intentionally NOT set here — leaving it unset triggers the
# multi-interface auto-detection logic in entrypoint.sh, which discovers every
# 10.x interface (ot-net, control-net, internet-dmz-net, attacker-net) and
# starts one AF_PACKET worker per bridge. Set SURICATA_IFACE in compose to
# force single-interface mode (e.g., for unit testing).
ENV DEVICE_ID=suricata-1

ENTRYPOINT ["/entrypoint.sh"]

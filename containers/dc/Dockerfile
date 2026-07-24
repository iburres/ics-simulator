# containers/dc/Dockerfile
#
# Meridian Process Controls — real Active Directory Domain Controller for the
# Enterprise Zone of the ICS Simulator topology.
#
# Runs a genuine Samba4 AD DC (not an emulator) provisioned at container start
# via `samba-tool domain provision`, serving real LDAP (389/636), Kerberos (88),
# and SMB (445). Deliberately a distinct internal namespace (MERIDIAN.LOCAL by
# default) from the public-facing meridian-process.com DNS zone already served
# by containers/dns-server/ — real organizations commonly split the two the
# same way.
#
# This is a REALISTIC domain, not a deliberately vulnerable one: a small
# OU/user/group structure is seeded so LDAP enumeration and BloodHound
# collection have real data to work with, but no intentionally weak accounts,
# Kerberoastable SPNs, or AS-REP-roastable flags are planted here — that
# content belongs to a future attack tutorial, not this device's baseline.
#
# Environment variables (with defaults, see entrypoint.sh):
#   AD_DOMAIN          — Fully-qualified AD realm  (default: MERIDIAN.LOCAL)
#   AD_NETBIOS         — Short NetBIOS domain name (default: MERIDIAN)
#   AD_ADMIN_PASSWORD  — Administrator account password (default: fixed known value)
#   AD_USER_PASSWORD   — Password for every seeded employee account (default: a
#                        different fixed known value, so students can't assume
#                        the Administrator password by guessing a shared one)
#
# Image: alpine:3.20 + samba-dc (~19 MiB package)
FROM alpine:3.20

RUN apk add --no-cache samba-dc

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV AD_DOMAIN=MERIDIAN.LOCAL \
    AD_NETBIOS=MERIDIAN \
    AD_ADMIN_PASSWORD=M3ridian!Admin \
    AD_USER_PASSWORD=M3ridian!2026

# LDAP (389), LDAPS (636), Kerberos (88, tcp+udp), SMB (445), Samba's own
# internal DNS for the AD zone (53, tcp+udp) — all real AD DC service ports.
EXPOSE 389/tcp
EXPOSE 636/tcp
EXPOSE 88/tcp
EXPOSE 88/udp
EXPOSE 445/tcp
EXPOSE 53/tcp
EXPOSE 53/udp

ENTRYPOINT ["/entrypoint.sh"]

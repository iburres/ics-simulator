#!/bin/sh
# entrypoint.sh — real Samba4 Active Directory Domain Controller.
#
# On first start, provisions a brand-new AD forest/domain via `samba-tool
# domain provision`, then seeds a small realistic OU/user/group structure
# (no deliberately weak accounts — see Dockerfile header), then runs `samba`
# in the foreground so every LDAP bind, Kerberos AS-REQ, and SMB session
# Docker captures on stdout is visible to students via `docker logs -f`.
#
# Re-provisioning is skipped on container restart (sam.ldb already present)
# so restarting the same container doesn't destroy/recreate the domain.
#
# Environment variables:
#   AD_DOMAIN          Fully-qualified AD realm  (default: MERIDIAN.LOCAL)
#   AD_NETBIOS         Short NetBIOS domain name (default: MERIDIAN)
#   AD_ADMIN_PASSWORD  Administrator account password (default: fixed known value)
#   AD_USER_PASSWORD   Password shared by every seeded employee account
#                      (deliberately different from AD_ADMIN_PASSWORD so
#                      students can't assume a single domain-wide password)
#
# NOTE on --option='posix:eadb=...': Samba's provision process sets an NT ACL
# on the sysvol directory using filesystem extended attributes by default,
# which fails with NT_STATUS_ACCESS_DENIED on Docker's overlay filesystem.
# Redirecting extended-attribute storage to a tdb database file (rather than
# real filesystem xattrs) is Samba's own documented workaround for exactly
# this environment and is what makes AD DC provisioning work inside a
# container at all.

set -e

AD_DOMAIN="${AD_DOMAIN:-MERIDIAN.LOCAL}"
AD_NETBIOS="${AD_NETBIOS:-MERIDIAN}"
AD_ADMIN_PASSWORD="${AD_ADMIN_PASSWORD:-M3ridian!Admin}"
AD_USER_PASSWORD="${AD_USER_PASSWORD:-M3ridian!2026}"
AD_LOG_LEVEL="${AD_LOG_LEVEL:-2}"
# DEVICE_ID is the scenario nodeId, injected by compose-generator.ts's
# buildDeviceEnv() for every device -- it matches the Docker Compose service
# name/network alias other containers use to resolve this one. Setting the
# container's own OS hostname to match (and passing the same value as
# --host-name below) makes Samba self-register its AD DNS records under the
# SAME name Docker's embedded DNS already resolves, instead of the random
# container-ID hostname Samba would otherwise pick up automatically.
DEVICE_ID="${DEVICE_ID:-dc-1}"
hostname "${DEVICE_ID}" 2>/dev/null || true

HOST_IP=$(hostname -i | awk '{print $1}')

echo "[otforge-dc] ================================================"
echo "[otforge-dc] Domain (realm):  ${AD_DOMAIN}"
echo "[otforge-dc] NetBIOS domain:  ${AD_NETBIOS}"
echo "[otforge-dc] Host IP:         ${HOST_IP}"
echo "[otforge-dc] Administrator password: ${AD_ADMIN_PASSWORD}"
echo "[otforge-dc] Seeded employee password (all accounts below): ${AD_USER_PASSWORD}"
echo "[otforge-dc] ================================================"

if [ ! -f /var/lib/samba/private/sam.ldb ]; then
    echo "[otforge-dc] No existing domain found -- provisioning a new AD forest..."
    rm -f /etc/samba/smb.conf

    samba-tool domain provision \
        --server-role=dc \
        --use-rfc2307 \
        --dns-backend=SAMBA_INTERNAL \
        --realm="${AD_DOMAIN}" \
        --domain="${AD_NETBIOS}" \
        --adminpass="${AD_ADMIN_PASSWORD}" \
        --host-ip="${HOST_IP}" \
        --host-name="${DEVICE_ID}" \
        --option="posix:eadb=/var/lib/samba/private/eadb.tdb" \
        --option="log level=${AD_LOG_LEVEL}"

    echo "[otforge-dc] Provisioning complete -- seeding realistic OU/user/group structure..."

    # Three departments, matching this project's fictional company (Meridian
    # Process Controls) -- a small, realistic org structure for LDAP
    # enumeration and BloodHound collection exercises. No deliberately weak
    # accounts, Kerberoastable SPNs, or AS-REP-roastable flags are set here.
    samba-tool ou create OU=IT
    samba-tool ou create OU=Engineering
    samba-tool ou create OU=Operations

    samba-tool group add IT-Staff --group-scope=Global
    samba-tool group add Engineering-Staff --group-scope=Global
    samba-tool group add Operations-Staff --group-scope=Global

    samba-tool user create schen "${AD_USER_PASSWORD}" --given-name=Sarah --surname=Chen --userou=OU=IT
    samba-tool user create mwebb "${AD_USER_PASSWORD}" --given-name=Marcus --surname=Webb --userou=OU=IT
    samba-tool user create eortiz "${AD_USER_PASSWORD}" --given-name=Elena --surname=Ortiz --userou=OU=Engineering
    samba-tool user create dkim "${AD_USER_PASSWORD}" --given-name=David --surname=Kim --userou=OU=Engineering
    samba-tool user create pnair "${AD_USER_PASSWORD}" --given-name=Priya --surname=Nair --userou=OU=Operations
    samba-tool user create tbaxter "${AD_USER_PASSWORD}" --given-name=Tom --surname=Baxter --userou=OU=Operations

    samba-tool group addmembers IT-Staff schen,mwebb
    samba-tool group addmembers Engineering-Staff eortiz,dkim
    samba-tool group addmembers Operations-Staff pnair,tbaxter

    echo "[otforge-dc] Seeded users: schen, mwebb (IT-Staff) / eortiz, dkim (Engineering-Staff) / pnair, tbaxter (Operations-Staff)"
else
    echo "[otforge-dc] Existing domain found -- skipping provisioning, starting as-is."
fi

echo "[otforge-dc] Starting Samba (LDAP 389/636, Kerberos 88, SMB 445, DNS 53)..."
echo "[otforge-dc] Every bind/auth/query will appear below (docker logs -f):"
echo ""

# -i (interactive/foreground) so Docker captures stdout; --debuglevel makes
# every LDAP bind, Kerberos ticket request, and SMB session visible.
exec samba -i --debuglevel="${AD_LOG_LEVEL}"

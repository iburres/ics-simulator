#!/usr/bin/env python3
"""
iec61850_read.py — Read live measurements from an IEC 61850 substation IED.

Reads MMXU1 (feeder-bay measurements: TotW, TotVAr, Hz, phase A voltage and
current) and the XCBR1.Pos breaker status over MMS (TCP 102).

Usage:
    python3 iec61850_read.py <ied-ip>

Example:
    python3 iec61850_read.py 10.200.10.12

How it works
------------
IEC 61850 substation devices (IEDs) expose their data model — logical
devices, logical nodes (MMXU = metering, XCBR = circuit breaker), and data
objects — over MMS (Manufacturing Message Specification, ISO 9506), an ASN.1/
BER-encoded client-server protocol layered on ISO session/presentation/ACSE
services (not just raw TCP like Modbus). Reimplementing an MMS client from
scratch in Python is not a reasonable one-file exercise the way the Modbus/
DNP3/BACnet scripts elsewhere in this folder are — this script instead calls
/opt/otforge/iec61850-client, a small C client built against libiec61850 (the
same open-source stack that builds the IED server itself), and just formats
its output.
"""

import argparse
import subprocess
import sys

CLIENT_BIN = "/opt/otforge/iec61850-client"


def main():
    parser = argparse.ArgumentParser(
        description="Read MMXU1 measurements + XCBR1 breaker status from an IEC 61850 IED"
    )
    parser.add_argument("host", help="IP address of the IEC 61850 IED (MMS server, TCP 102)")
    args = parser.parse_args()

    print(f"[iec61850] Connecting to {args.host}:102 (MMS) ...")
    result = subprocess.run([CLIENT_BIN, args.host, "read"])
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()

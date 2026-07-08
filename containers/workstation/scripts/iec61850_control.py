#!/usr/bin/env python3
"""
iec61850_control.py — Authorized breaker control of an IEC 61850 IED's XCBR1.

Sends an MMS client Operate service request to open (trip) or close the
feeder breaker modeled by the IED's XCBR1 logical node. This is the same
control operation a real engineering workstation or SCADA client would use —
run from here (the Control zone) it represents normal, authorized operation.

Usage:
    python3 iec61850_control.py <ied-ip> <open|close>

Examples:
    python3 iec61850_control.py 10.200.10.12 open
    python3 iec61850_control.py 10.200.10.12 close

See iec61850_read.py for why this shells out to a compiled C client
(/opt/otforge/iec61850-client) rather than a hand-rolled MMS implementation.
"""

import argparse
import subprocess
import sys

CLIENT_BIN = "/opt/otforge/iec61850-client"


def main():
    parser = argparse.ArgumentParser(
        description="Operate XCBR1.Pos (feeder breaker) on an IEC 61850 IED"
    )
    parser.add_argument("host", help="IP address of the IEC 61850 IED (MMS server, TCP 102)")
    parser.add_argument("action", choices=["open", "close"],
                        help="open = trip the breaker, close = re-close it")
    args = parser.parse_args()

    print(f"[iec61850] Connecting to {args.host}:102 (MMS) ...")
    print(f"[iec61850] Operating XCBR1.Pos -> {args.action.upper()}")
    result = subprocess.run([CLIENT_BIN, args.host, args.action])
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()

/*
 * client.c — OTForge IEC 61850 MMS client (read + control).
 *
 * A minimal libiec61850 IedConnection client used for both legitimate and
 * unauthorized operation against the otforge-iec61850 IED (see server.c).
 * The same binary is copied into the engineering-workstation image (legitimate
 * polling/operation) and the attack-machine image (unauthorized operation from
 * the wrong network zone) — MMS has no authentication in this deployment, so
 * "attack" here means running the identical, well-formed client command from
 * an unauthorized source, exactly like the DNP3 Direct Operate lesson in Lab 03.
 *
 * Usage:
 *   iec61850-client <host> read           — print live MMXU1 measurements
 *   iec61850-client <host> open           — operate XCBR1.Pos -> OPEN (trip)
 *   iec61850-client <host> close          — operate XCBR1.Pos -> CLOSE
 *
 * Object references match the data model built in server.c: IED name
 * "OTForgeIED", logical device "BAY" -> domain id "OTForgeIEDBAY".
 */

#include "iec61850_client.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define DOMAIN "OTForgeIEDBAY"

static void printMeasurement(IedConnection con, const char* label, const char* objRef)
{
    IedClientError error;
    MmsValue* value = IedConnection_readObject(con, &error, objRef, IEC61850_FC_MX);

    if (error == IED_ERROR_OK && value != NULL) {
        printf("  %-8s %.2f\n", label, MmsValue_toFloat(value));
        MmsValue_delete(value);
    } else {
        printf("  %-8s <read error %d>\n", label, (int) error);
    }
}

static int doRead(IedConnection con)
{
    printf("[iec61850-client] MMXU1 measurements:\n");
    printMeasurement(con, "TotW",   DOMAIN "/MMXU1.TotW.mag.f");
    printMeasurement(con, "TotVAr", DOMAIN "/MMXU1.TotVAr.mag.f");
    printMeasurement(con, "Hz",     DOMAIN "/MMXU1.Hz.mag.f");
    printMeasurement(con, "PhV.A",  DOMAIN "/MMXU1.PhV.phsA.cVal.mag.f");
    printMeasurement(con, "A.A",    DOMAIN "/MMXU1.A.phsA.cVal.mag.f");

    IedClientError error;
    MmsValue* pos = IedConnection_readObject(con, &error, DOMAIN "/XCBR1.Pos.stVal", IEC61850_FC_ST);
    if (error == IED_ERROR_OK && pos != NULL) {
        MmsType type = MmsValue_getType(pos);
        int code = (type == MMS_BIT_STRING) ? MmsValue_getBitStringAsInteger(pos) : MmsValue_toInt32(pos);
        /* Empirically verified against server.c's IedServer_updateDbposValue: code 1 =
           CLOSED (DBPOS_ON), code 2 = OPEN/tripped (DBPOS_OFF). Confirmed by cross-checking
           against the server's own "XCBR1.Pos operated -> OPEN/CLOSED" log line. */
        const char* label = (code == 1) ? "CLOSED" : (code == 2) ? "OPEN" : "INTERMEDIATE/BAD";
        printf("[iec61850-client] XCBR1.Pos.stVal = %s (code=%d, mmsType=%d)\n", label, code, (int) type);
        MmsValue_delete(pos);
    } else {
        printf("[iec61850-client] XCBR1.Pos.stVal <read error %d>\n", (int) error);
    }
    return 0;
}

static int doControl(IedConnection con, bool close)
{
    ControlObjectClient control = ControlObjectClient_create(DOMAIN "/XCBR1.Pos", con);
    if (control == NULL) {
        printf("[iec61850-client] ERROR: could not create control object for XCBR1.Pos\n");
        return 1;
    }

    MmsValue* ctlVal = MmsValue_newBoolean(close);
    bool ok = ControlObjectClient_operate(control, ctlVal, 0);

    printf("[iec61850-client] Operate %s -> %s\n",
           close ? "CLOSE" : "OPEN/TRIP",
           ok ? "accepted" : "FAILED");

    MmsValue_delete(ctlVal);
    ControlObjectClient_destroy(control);
    return ok ? 0 : 1;
}

int main(int argc, char** argv)
{
    if (argc < 3) {
        printf("Usage: %s <host> <read|open|close>\n", argv[0]);
        return 1;
    }

    const char* hostname = argv[1];
    const char* mode = argv[2];
    int tcpPort = 102;

    IedConnection con = IedConnection_create();
    IedClientError error;
    IedConnection_connect(con, &error, hostname, tcpPort);

    if (error != IED_ERROR_OK) {
        printf("[iec61850-client] ERROR: failed to connect to %s:%d (error %d)\n",
               hostname, tcpPort, (int) error);
        IedConnection_destroy(con);
        return 1;
    }

    int rc;
    if (strcmp(mode, "read") == 0) {
        rc = doRead(con);
    } else if (strcmp(mode, "open") == 0) {
        rc = doControl(con, false);
    } else if (strcmp(mode, "close") == 0) {
        rc = doControl(con, true);
    } else {
        printf("Unknown mode '%s' — use read, open, or close\n", mode);
        rc = 1;
    }

    IedConnection_close(con);
    IedConnection_destroy(con);
    return rc;
}

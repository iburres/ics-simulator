##! ICS Simulator — shared Zeek monitoring definitions.
##! Always loaded (via local.zeek) regardless of which optional protocol
##! analyzers (modbus.zeek, dnp3.zeek) the scenario selects. Provides the
##! shared ICSMonitor module — the Notice::Type enum, zone classification,
##! and the generic per-connection ICS summary line — that the protocol-
##! specific scripts build on.

@load base/frameworks/notice

module ICSMonitor;

export {
    redef enum Notice::Type += {
        ## A Modbus write-multiple-registers command was observed.
        Modbus_Write_Registers,
        ## A DNP3 direct-operate command was observed.
        DNP3_Direct_Operate,
        ## Unusual cross-zone ICS traffic.
        Cross_Zone_Traffic,
    };
}

# ── Network definitions ───────────────────────────────────────────────────────
# Subnets are dynamically assigned at simulation start by findFreeSubnets() and
# may be anything in 10.x.x.x space — do NOT hardcode specific /24s here.
# All 10.0.0.0/8 addresses are simulation-internal; anything outside is external
# (e.g., public internet reached from the attacker VM).

const SIMULATION_NET: subnet = 10.0.0.0/8;

function zone_name(a: addr): string {
    if (a in SIMULATION_NET) return "Simulation";
    return "External";
}

# ── Connection summary ────────────────────────────────────────────────────────
# Port-based classification only — this fires regardless of which optional
# analyzer scripts are loaded, since it doesn't depend on their event handlers.

event connection_state_remove(c: connection) {
    # Log all ICS protocol connections
    if (c$id$resp_p == 502/tcp || c$id$resp_p == 20000/tcp || c$id$resp_p == 4840/tcp) {
        local proto = c$id$resp_p == 502/tcp   ? "Modbus" :
                      c$id$resp_p == 20000/tcp ? "DNP3"   : "OPC-UA";
        print fmt("[ICS] %s  %s:%d → %s:%d  duration=%.1fs  bytes=%d",
                  proto,
                  c$id$orig_h, c$id$orig_p,
                  c$id$resp_h, c$id$resp_p,
                  c$duration,
                  c$orig$size + c$resp$size);
    }
}

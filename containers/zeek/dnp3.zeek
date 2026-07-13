##! ICS Simulator — DNP3 protocol analysis.
##! Optional script, selected via the IDSPanel "DNP3 analyzer" checkbox
##! (scenario.security.ids.zeekScripts). Loads Zeek's built-in DNP3 analyzer
##! and logs ICS-specific DNP3 events on top of the shared ICSMonitor module.

@load ics-monitor
@load base/protocols/dnp3

module ICSMonitor;

# Zeek 8.x: signature is (c, is_orig, application, fc); fir/fin/con/uns/seq removed.
event dnp3_application_request_header(c: connection, is_orig: bool,
        application: count, fc: count) {
    # FC 3 = DIRECT_OPERATE
    if (fc == 3) {
        NOTICE([$note=DNP3_Direct_Operate,
                $msg=fmt("DNP3 DirectOperate: %s → %s",
                         c$id$orig_h, c$id$resp_h),
                $conn=c]);
    }
}

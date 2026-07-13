##! ICS Simulator — Modbus TCP protocol analysis.
##! Optional script, selected via the IDSPanel "Modbus analyzer" checkbox
##! (scenario.security.ids.zeekScripts). Loads Zeek's built-in Modbus analyzer
##! and logs ICS-specific Modbus events on top of the shared ICSMonitor module.

@load ics-monitor
@load base/protocols/modbus

module ICSMonitor;

# Zeek 8.x: parameter order is (c, headers, is_orig); ModbusData type was removed.
event modbus_message(c: connection, headers: ModbusHeaders, is_orig: bool) {
    local src_zone  = zone_name(c$id$orig_h);
    local dst_zone  = zone_name(c$id$resp_h);

    if (src_zone != dst_zone) {
        NOTICE([$note=Cross_Zone_Traffic,
                $msg=fmt("Modbus %s→%s: %s:%d → %s:%d",
                         src_zone, dst_zone,
                         c$id$orig_h, c$id$orig_p,
                         c$id$resp_h, c$id$resp_p),
                $conn=c]);
    }
}

event modbus_write_multiple_registers_request(c: connection, headers: ModbusHeaders,
        start_address: count, registers: ModbusRegisters) {
    NOTICE([$note=Modbus_Write_Registers,
            $msg=fmt("Modbus WriteMultipleRegs: %s → %s  start=%d  count=%d",
                     c$id$orig_h, c$id$resp_h, start_address, |registers|),
            $conn=c]);
}

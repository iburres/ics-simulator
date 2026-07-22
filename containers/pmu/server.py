#!/usr/bin/env python3
"""
server.py — Real IEEE C37.118 PMU (Phasor Measurement Unit) for the ICS Simulator.

Polls the generator process-unit wired to this device over Modbus TCP (same
"field I/O in" role containers/dcs/server.py plays for its field devices),
then re-exposes what it reads as a real IEEE C37.118-2011 synchrophasor data
stream — CONFIG-2/HEADER/DATA frames, real CRC-CCITT checksums, the actual
command handshake a real PDC (Phasor Data Concentrator) sends. This is the
"aggregation and re-exposure over a different real protocol" pattern already
established by the DCS controller, applied to synchrophasor monitoring
instead of OPC UA.

Scope (a deliberate subset, same kind of cut as containers/ethernetip's
explicit-messaging-only EtherNet/IP and containers/profinet's DCP-only
PROFINET): a single fixed PMU station, floating-point format throughout
(FREQ/DFREQ/ANALOG/phasor all IEEE 754 float, not the alternate 16-bit
integer format), CONFIG-2 + HEADER + DATA frames only (CONFIG-1 is aliased
to CONFIG-2's content since this device has no dynamically-reconfigurable
channel set to distinguish them from; CONFIG-3, added in the 2011 revision
for extended station/channel metadata, is out of scope).

Rotor-angle physics — the actual point of a synchrophasor, not just a
frequency meter: angular separation between two machines is the
time-integral of their frequency deviation from nominal. This container
integrates that drift itself every poll tick (dθ/dt = 2π(f − f_nominal)),
entirely independent of containers/process-sim/sim.py's generator physics —
the existing generator device is completely untouched by this feature.

Polled generator registers (see containers/process-sim/sim.py's register
map — all read via one Holding_Registers read starting at HR 6):
    HR 6  FREQ_PV       ×0.01 Hz    — generator frequency
    HR 7  VOLTAGE_PCT   ×0.01 %     — terminal voltage, % of rated
    HR 8  POWER_PV      ×0.1 MW     — active power output
    HR 9  REACTIVE_PV   ×0.1 MVAR   — reactive power output
    CO 0  PUMP_CMD                  — reused as the generator's breaker coil

Environment variables:
    DEVICE_ID              — node identifier string, used in logging
    DEVICE_CATEGORY        — logged at startup for Docker Compose traceability
    PMU_PORT               — TCP port for the C37.118 data stream (default 4712,
                             the de facto industry-standard port; the spec itself
                             does not mandate one)
    PMU_IDCODE             — IEEE C37.118 IDCODE, the station identifier a PDC
                             uses to distinguish streams (default 1)
    PMU_STATION_NAME       — STN field in the CONFIG-2 frame, truncated/padded
                             to 16 ASCII characters (default "OTForge PMU")
    PMU_DATA_RATE_FPS      — DATA frame reporting rate in frames/second; real
                             PMUs commonly use 10/25/30/50/60 (default 30)
    PMU_NOMINAL_FREQ_HZ    — nominal system frequency, 60 (Americas) or 50
                             (most of the rest of the world) (default 60)
    PMU_NOMINAL_LINE_VOLTAGE_V — nominal line (phase-to-phase) voltage in volts,
                             used to convert the generator's voltage_pct into a
                             plausible phase-to-neutral phasor magnitude
                             (default 138000, a common US transmission voltage)
    GENERATOR_IP           — Docker network IP of the wired generator
                             process-unit (compose-generator.ts injects this
                             from canvas edges, same pattern as PROCESS_SIM_IP).
                             Empty/unset means the PMU was placed standalone —
                             it still starts cleanly and streams steady-state
                             defaults (nominal freq, 100% voltage, zero MW/MVAR).

Attacker angle (not built into a tutorial yet, same "the protocol itself has
no authentication" property this project's other real protocol servers
demonstrate): every C37.118 command in this implementation — including
CMD_TURN_OFF, which silences the data stream a PDC/operator relies on for
wide-area grid visibility — is accepted from any TCP client with zero
authentication, exactly like the real protocol.

Protocol reference: IEEE Std C37.118.2-2011, "IEEE Standard for
Synchrophasor Data Transfer for Power Systems" (frame formats, CRC-CCITT
algorithm, command codes).
Library versions: pymodbus 3.7.4 (client mode, same as containers/dcs).
"""

import asyncio
import logging
import math
import os
import struct
import time

from pymodbus.client import AsyncModbusTcpClient

# ── Configuration ─────────────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("ics-pmu")

DEVICE_ID    = os.getenv("DEVICE_ID", "pmu-1")
CATEGORY     = os.getenv("DEVICE_CATEGORY", "pmu")
PORT         = int(os.getenv("PMU_PORT", "4712"))
ID_CODE      = int(os.getenv("PMU_IDCODE", "1"))
STATION_NAME = os.getenv("PMU_STATION_NAME", "OTForge PMU")
DATA_RATE_FPS = int(os.getenv("PMU_DATA_RATE_FPS", "30"))
NOMINAL_FREQ_HZ = float(os.getenv("PMU_NOMINAL_FREQ_HZ", "60"))
NOMINAL_LINE_VOLTAGE_V = float(os.getenv("PMU_NOMINAL_LINE_VOLTAGE_V", "138000"))
NOMINAL_PHASE_VOLTAGE_V = NOMINAL_LINE_VOLTAGE_V / math.sqrt(3)

GENERATOR_IP = os.getenv("GENERATOR_IP", "").strip()
GENERATOR_PORT = 502
GENERATOR_UNIT_ID = 1
POLL_INTERVAL_SECONDS = 1.0
POLL_TIMEOUT_SECONDS = 2.0

# Modbus registers on the polled generator process-unit (see module docstring).
HR_FREQ_START = 6  # reads HR 6-9 (FREQ, VOLTAGE, POWER, REACTIVE) in one call
CO_BREAKER = 0

# IEEE C37.118 frame type codes (SYNC byte 2, bits 6-4)
FT_DATA = 0
FT_HEADER = 1
FT_CFG1 = 2
FT_CFG2 = 3
FT_CMD = 4
VERSION = 1  # SYNC byte 2, bits 3-0

# C37.118 command codes (CMD field of a command frame)
CMD_TURN_OFF = 1
CMD_TURN_ON = 2
CMD_SEND_HDR = 3
CMD_SEND_CFG1 = 4
CMD_SEND_CFG2 = 5


# ── Shared PMU state — written by poll_generator(), read by the frame builders ──

class PmuState:
    def __init__(self) -> None:
        self.freq_hz = NOMINAL_FREQ_HZ
        self.prev_freq_hz = NOMINAL_FREQ_HZ
        self.voltage_pct = 100.0
        self.power_mw = 0.0
        self.reactive_mvar = 0.0
        self.breaker_closed = False
        self.angle_rad = 0.0
        self.connected = False  # last poll of the generator succeeded


STATE = PmuState()


# ── Modbus polling of the wired generator process-unit ──────────────────────

async def poll_generator() -> None:
    """
    Background task — polls the wired generator every POLL_INTERVAL_SECONDS.

    Opens a fresh Modbus TCP connection each cycle rather than holding a
    persistent client, exactly like containers/dcs/server.py's
    poll_field_device(): simpler, more robust failure recovery — a
    generator that's mid-restart or briefly unreachable just produces one
    skipped poll, not a client left needing its own reconnect logic.

    Also integrates rotor-angle drift every tick, whether or not the poll
    succeeded — a real PMU free-runs its own oscillator between samples of
    its underlying source, so frequency holds its last known value and the
    angle continues drifting at that rate rather than freezing.
    """
    if not GENERATOR_IP:
        log.info("No GENERATOR_IP configured — streaming steady-state defaults (standalone placement).")
        return

    while True:
        await asyncio.sleep(POLL_INTERVAL_SECONDS)
        client = AsyncModbusTcpClient(GENERATOR_IP, port=GENERATOR_PORT, timeout=POLL_TIMEOUT_SECONDS)
        try:
            await client.connect()
            if not client.connected:
                log.warning("Generator %s: connection failed", GENERATOR_IP)
                STATE.connected = False
            else:
                hr = await client.read_holding_registers(HR_FREQ_START, count=4, slave=GENERATOR_UNIT_ID)
                co = await client.read_coils(CO_BREAKER, count=1, slave=GENERATOR_UNIT_ID)

                if not hr.isError():
                    STATE.prev_freq_hz = STATE.freq_hz
                    STATE.freq_hz = hr.registers[0] / 100.0
                    STATE.voltage_pct = hr.registers[1] / 100.0
                    STATE.power_mw = hr.registers[2] / 10.0
                    STATE.reactive_mvar = hr.registers[3] / 10.0
                    STATE.connected = True
                else:
                    STATE.connected = False

                if not co.isError():
                    STATE.breaker_closed = bool(co.bits[0])
        except Exception as exc:  # noqa: BLE001 — a poll failure must not kill this background task
            log.warning("Generator %s: poll error — %s", GENERATOR_IP, exc)
            STATE.connected = False
        finally:
            client.close()

        # dθ/dt = 2π(f - f_nominal) — angular separation is literally the
        # time-integral of frequency deviation. Wrapped to [-π, π].
        STATE.angle_rad += 2 * math.pi * (STATE.freq_hz - NOMINAL_FREQ_HZ) * POLL_INTERVAL_SECONDS
        STATE.angle_rad = ((STATE.angle_rad + math.pi) % (2 * math.pi)) - math.pi


# ── CRC-CCITT (IEEE C37.118's CHK field algorithm) ──────────────────────────

def _crc_ccitt(data: bytes) -> int:
    """
    CRC-CCITT: polynomial 0x1021, initial value 0xFFFF, no input/output
    reflection, no final XOR — the exact algorithm the C37.118 spec defines
    for the CHK field. Computed over every byte of the frame except the
    trailing 2-byte CHK field itself. A simple bit-loop, not a lookup
    table — frames here are small (well under 100 bytes) and infrequent
    enough (tens of frames/second at most) that clarity wins over speed,
    matching this project's teaching-code style elsewhere.
    """
    crc = 0xFFFF
    for byte in data:
        crc ^= byte << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


# ── Common frame header + assembly ──────────────────────────────────────────

def _soc_fracsec() -> tuple[int, int]:
    """SOC (whole seconds since the Unix epoch) + FRACSEC (fraction, TIME_BASE=1_000_000)."""
    now = time.time()
    soc = int(now)
    fracsec = int((now - soc) * 1_000_000) & 0x00FFFFFF  # top byte (time quality) left at 0 = locked/good
    return soc, fracsec


def _build_frame(frame_type: int, payload: bytes) -> bytes:
    """
    Assembles a complete C37.118 frame: 2-byte SYNC, 2-byte FRAMESIZE,
    2-byte IDCODE, 4-byte SOC, 4-byte FRACSEC (14-byte common header),
    then the frame-type-specific payload, then a 2-byte CRC-CCITT CHK
    computed over everything before it.
    """
    sync_byte2 = 0x80 | ((frame_type & 0x07) << 4) | (VERSION & 0x0F)
    soc, fracsec = _soc_fracsec()
    body = struct.pack(">H", ID_CODE) + struct.pack(">I", soc) + struct.pack(">I", fracsec) + payload
    total_len = 2 + 2 + len(body) + 2  # SYNC + FRAMESIZE + body + CHK
    frame_wo_chk = struct.pack(">BBH", 0xAA, sync_byte2, total_len) + body
    return frame_wo_chk + struct.pack(">H", _crc_ccitt(frame_wo_chk))


def _pad16(text: str) -> bytes:
    """Encode a station/channel name to the fixed 16-byte ASCII field C37.118 uses throughout."""
    return text.encode("ascii", errors="replace")[:16].ljust(16, b" ")


# ── DATA frame ────────────────────────────────────────────────────────────────

def _build_data_payload() -> bytes:
    """
    DATA frame payload — floating-point format throughout (matching the
    FORMAT bits set in CONFIG-2): STAT word, 1 phasor (polar: magnitude in
    volts, angle in radians), FREQ + DFREQ (deviation from nominal / rate
    of change, both Hz), 2 ANALOG (MW, MVAR), 1 DIGITAL status word
    (bit 0 = breaker closed).
    """
    stat = 0x0000 if (STATE.connected or not GENERATOR_IP) else 0x8000  # bit 15 = data error

    magnitude_v = NOMINAL_PHASE_VOLTAGE_V * (STATE.voltage_pct / 100.0)
    phasor = struct.pack(">ff", magnitude_v, STATE.angle_rad)

    freq_deviation_hz = STATE.freq_hz - NOMINAL_FREQ_HZ
    dfreq_hz_per_s = (STATE.freq_hz - STATE.prev_freq_hz) / POLL_INTERVAL_SECONDS
    freq_dfreq = struct.pack(">ff", freq_deviation_hz, dfreq_hz_per_s)

    analogs = struct.pack(">ff", STATE.power_mw, STATE.reactive_mvar)
    digital = struct.pack(">H", 0x0001 if STATE.breaker_closed else 0x0000)

    return struct.pack(">H", stat) + phasor + freq_dfreq + analogs + digital


# ── CONFIG-2 frame (also aliased for CONFIG-1 — see module docstring) ───────

def _build_cfg2_payload() -> bytes:
    """
    CONFIG-2 frame payload: TIME_BASE, NUM_PMU=1, one station block (STN/
    IDCODE/FORMAT/PHNMR/ANNMR/DGNMR/channel names/unit-conversion words/
    FNOM/CFGCNT), then DATA_RATE. Tells a PDC everything it needs to parse
    this device's DATA frames.
    """
    time_base = struct.pack(">I", 1_000_000)
    num_pmu = struct.pack(">H", 1)

    stn = _pad16(STATION_NAME)
    idcode = struct.pack(">H", ID_CODE)
    # FORMAT bits: bit0=freq/dfreq float, bit1=analog float, bit2=phasor float, bit3=polar coordinates
    fmt = struct.pack(">H", 0b0000_1111)
    phnmr = struct.pack(">H", 1)
    annmr = struct.pack(">H", 2)
    dgnmr = struct.pack(">H", 1)

    phnam = _pad16("VA")
    annam = _pad16("MW") + _pad16("MVAR")
    dgnam = _pad16("BREAKER STATUS")

    # PHUNIT: high byte = phasor type (0=voltage), low 3 bytes = scale factor
    # (vestigial for float-format channels, but the field must still be present).
    phunit = struct.pack(">I", (0 << 24) | 1)
    anunit = struct.pack(">I", (1 << 24) | 1) * 2  # ANUNIT per analog: type=1 (analog input)
    digunit = struct.pack(">HH", 0x0000, 0xFFFF)  # normal-status mask, valid-input mask

    fnom = struct.pack(">H", 1 if abs(NOMINAL_FREQ_HZ - 50) < 0.1 else 0)
    cfgcnt = struct.pack(">H", 1)  # static — this device's channel set never changes at runtime
    data_rate = struct.pack(">h", DATA_RATE_FPS)

    return (
        time_base + num_pmu
        + stn + idcode + fmt + phnmr + annmr + dgnmr
        + phnam + annam + dgnam
        + phunit + anunit + digunit
        + fnom + cfgcnt
        + data_rate
    )


def _build_header_payload() -> bytes:
    """HEADER frame — free-text descriptive frame, no fixed structure beyond ASCII bytes."""
    text = f"OTForge PMU {DEVICE_ID} -- IEEE C37.118-2011 synchrophasor (teaching implementation)"
    return text.encode("ascii", errors="replace")


# ── TCP session handling ──────────────────────────────────────────────────────

class _PmuConnection:
    def __init__(self) -> None:
        self.streaming_task: asyncio.Task | None = None

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = writer.get_extra_info("peername")
        log.info("PDC connected: %s", peer)
        try:
            while True:
                # Read SYNC(2)+FRAMESIZE(2) first so we know exactly how many
                # more bytes make up the rest of this frame.
                prefix = await reader.readexactly(4)
                sync0, _sync1, framesize = struct.unpack(">BBH", prefix)
                if sync0 != 0xAA:
                    log.warning("Bad SYNC byte from %s: 0x%02x — closing", peer, sync0)
                    break
                rest = await reader.readexactly(framesize - 4)
                await self._handle_command_frame(prefix + rest, writer, peer)
        except (asyncio.IncompleteReadError, ConnectionResetError):
            pass
        finally:
            if self.streaming_task:
                self.streaming_task.cancel()
            writer.close()
            log.info("PDC disconnected: %s", peer)

    async def _handle_command_frame(self, frame: bytes, writer: asyncio.StreamWriter, peer) -> None:
        sync1 = frame[1]
        frame_type = (sync1 >> 4) & 0x07
        if frame_type != FT_CMD:
            log.info("Ignoring non-command frame type %d from %s", frame_type, peer)
            return

        received_chk = struct.unpack(">H", frame[-2:])[0]
        if _crc_ccitt(frame[:-2]) != received_chk:
            log.warning("Bad CRC on command frame from %s — ignoring", peer)
            return

        payload = frame[14:-2]  # command frame payload is just CMD (2 bytes)
        if len(payload) < 2:
            return
        cmd = struct.unpack(">H", payload[:2])[0]

        if cmd == CMD_TURN_OFF:
            log.info("CMD from %s: data transmission OFF", peer)
            if self.streaming_task:
                self.streaming_task.cancel()
                self.streaming_task = None
        elif cmd == CMD_TURN_ON:
            log.info("CMD from %s: data transmission ON (%d fps)", peer, DATA_RATE_FPS)
            if self.streaming_task:
                self.streaming_task.cancel()
            self.streaming_task = asyncio.create_task(self._stream_data(writer))
        elif cmd == CMD_SEND_HDR:
            writer.write(_build_frame(FT_HEADER, _build_header_payload()))
            await writer.drain()
        elif cmd == CMD_SEND_CFG2:
            writer.write(_build_frame(FT_CFG2, _build_cfg2_payload()))
            await writer.drain()
        elif cmd == CMD_SEND_CFG1:
            # CFG-1 (capability) == CFG-2 (currently transmitted) for this
            # fixed single-station PMU — no reconfigurable channel set exists
            # to distinguish them.
            writer.write(_build_frame(FT_CFG1, _build_cfg2_payload()))
            await writer.drain()
        else:
            log.info("Unsupported/ignored C37.118 command %d from %s", cmd, peer)

    async def _stream_data(self, writer: asyncio.StreamWriter) -> None:
        interval = 1.0 / DATA_RATE_FPS
        try:
            while True:
                writer.write(_build_frame(FT_DATA, _build_data_payload()))
                await writer.drain()
                await asyncio.sleep(interval)
        except (ConnectionResetError, asyncio.CancelledError):
            pass


async def _handle_connection(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    await _PmuConnection().handle(reader, writer)


async def main() -> None:
    log.info(
        "PMU starting -- id=%s  category=%s  port=%d  idcode=%d  station=%r  rate=%dfps  fnom=%.0fHz",
        DEVICE_ID, CATEGORY, PORT, ID_CODE, STATION_NAME, DATA_RATE_FPS, NOMINAL_FREQ_HZ,
    )
    if GENERATOR_IP:
        log.info("  Polling generator process-unit at %s:%d every %.0fs",
                  GENERATOR_IP, GENERATOR_PORT, POLL_INTERVAL_SECONDS)
    else:
        log.info("  No generator wired — streaming steady-state defaults (standalone placement)")

    server = await asyncio.start_server(_handle_connection, "0.0.0.0", PORT)
    log.info("Listening on TCP port %d (C37.118 synchrophasor data)", PORT)

    asyncio.create_task(poll_generator())
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())

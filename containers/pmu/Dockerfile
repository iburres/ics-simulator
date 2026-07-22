FROM python:3.12-alpine

WORKDIR /app

# pymodbus 3.7.4 — used here as a CLIENT (polling the wired generator
# process-unit), same version pin as containers/dcs for consistency. The
# C37.118 side is hand-rolled (struct packing, no third-party library),
# same approach as containers/ethernetip and containers/profinet.
RUN pip install --no-cache-dir "pymodbus==3.7.4"

COPY server.py .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Defaults — all overridable via docker-compose environment:
ENV DEVICE_ID=pmu-1 \
    DEVICE_CATEGORY=pmu \
    PMU_PORT=4712 \
    PMU_IDCODE=1 \
    PMU_STATION_NAME="OTForge PMU" \
    PMU_DATA_RATE_FPS=30 \
    PMU_NOMINAL_FREQ_HZ=60 \
    GENERATOR_IP=""

# IEEE C37.118 — de facto standard TCP port for synchrophasor data.
EXPOSE 4712

ENTRYPOINT ["./entrypoint.sh"]

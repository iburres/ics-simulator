FROM python:3.12-alpine

WORKDIR /app

# paho-mqtt 2.x — the standard Python MQTT client library, same "use a real
# library when one exists" choice this project already makes for Modbus
# (pymodbus) and OPC UA (asyncua), rather than hand-rolling MQTT wire framing
# the way containers/ethernetip or containers/pmu hand-roll protocols that
# have no comparably standard small client library.
RUN pip install --no-cache-dir "paho-mqtt==2.1.0"

COPY server.py .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Defaults — all overridable via docker-compose environment:
ENV DEVICE_ID=iiot-1 \
    DEVICE_CATEGORY=iiot-sensor \
    MQTT_BROKER_IP="" \
    MQTT_BROKER_PORT=1883 \
    SENSOR_KIND=temperature \
    SENSOR_WAVEFORM=sine \
    SENSOR_MIN_VALUE=0 \
    SENSOR_MAX_VALUE=100 \
    SENSOR_UNITS="" \
    SENSOR_NOISE_PERCENT=5 \
    SENSOR_SAMPLE_RATE_MS=1000 \
    SENSOR_TAG_NAME=""

ENTRYPOINT ["./entrypoint.sh"]

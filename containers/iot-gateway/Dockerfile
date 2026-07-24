FROM python:3.12-alpine

# Real Mosquitto broker (Alpine's own community package — the exact same
# software a real IIoT gateway product would embed) plus pymodbus (client
# mode, same version pin as containers/dcs) and paho-mqtt (client mode) for
# the Python sidecar that bridges Modbus field devices onto the broker.
# This is not a new container SHAPE for this project — it mirrors OpenPLC's
# own container, which also runs a compiled runtime (matiec/openplc binary)
# alongside a Python webserver process — just a different pair of processes.
RUN apk add --no-cache mosquitto

WORKDIR /app

RUN pip install --no-cache-dir "pymodbus==3.7.4" "paho-mqtt==2.1.0"

COPY mosquitto.conf /etc/mosquitto/mosquitto.conf
COPY sidecar.py .
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Defaults — all overridable via docker-compose environment:
ENV DEVICE_ID=gateway-1 \
    DEVICE_CATEGORY=iot-gateway \
    MQTT_PORT=1883 \
    GATEWAY_FIELD_DEVICES=""

# Standard MQTT port.
EXPOSE 1883

ENTRYPOINT ["./entrypoint.sh"]

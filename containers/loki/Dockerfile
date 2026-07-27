# containers/loki/Dockerfile — Multi-platform mirror of grafana/loki.
#
# Official image supports linux/amd64 and linux/arm64.
#
# PINNED, not :latest. `grafana/loki:latest` is a rolling tag: a rebuild on
# 2026-07-22 silently advanced it to 3.7.4 (after Lab 04 shipped), which — with
# the old persisted loki-data volume — hung at /ready = 503 and broke the whole
# Suricata/Zeek -> Grafana pipeline in class. Loki storage is now ephemeral
# (see packages/orchestrator/src/compose-generator.ts), and this pin stops the
# base image from drifting out from under the labs again. 3.7.4 is verified to
# work cleanly. Bump this deliberately, not implicitly.
FROM grafana/loki:3.7.4

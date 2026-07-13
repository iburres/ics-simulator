/**
 * grafana-provisioning.ts — Writes Grafana and Promtail provisioning files to
 * the scenario directory before Docker Compose starts the simulation.
 *
 * Grafana supports file-based provisioning (datasources, dashboard providers,
 * and pre-built dashboard JSON) via the /etc/grafana/provisioning directory.
 * Compose mounts the files written here as read-only volumes into the Grafana
 * container so students see a fully-wired dashboard the moment the simulation
 * starts — no manual datasource configuration required.
 *
 * Promtail is the log-shipping sidecar that reads Suricata EVE JSON and Zeek
 * logs from their named volumes and pushes them to the Loki container. Without
 * Promtail, Loki would receive no data even though both Suricata and Zeek are
 * writing logs to disk.
 *
 * Directory structure written under <scenarioDir>:
 *
 *   grafana/
 *     provisioning/
 *       datasources/otflab.yaml   ← InfluxDB + Loki datasources (explicit UIDs)
 *       dashboards/otflab.yaml    ← File-based dashboard provider config
 *     dashboards/
 *       ics-overview.json         ← ICS Lab Overview dashboard (Suricata + Zeek)
 *   promtail/
 *     config.yaml                 ← Reads suricata-logs + zeek-logs, pushes to Loki
 *
 * IP addresses match the fixed system-service assignments in compose-generator.ts.
 * System services occupy .240–.249 so user devices (.10+) never collide with them:
 *   InfluxDB  → 10.200.20.240 : 8086  (Control zone, Level 3)
 *   Loki      → 10.200.20.241 : 3100  (Control zone, Level 3)
 *   Grafana   → 10.200.20.242 : 3000  (Control zone, Level 3)
 *   FUXA      → 10.200.20.243
 *   Promtail  → 10.200.20.244
 */

import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import yaml from 'js-yaml'
import { zoneIpPrefix } from './network-config'

/**
 * Default Control-zone prefix derived from ZONE_DEFAULTS.
 * Used when writeGrafanaProvisioning() is called without an explicit prefix override,
 * e.g., in unit tests that don't run subnet auto-detection.
 * The Control zone (Level 3) hosts InfluxDB, Loki, Grafana, FUXA, and Promtail.
 */
const DEFAULT_CONTROL_PREFIX = zoneIpPrefix('control')

/**
 * Writes all Grafana and Promtail provisioning files to the scenario directory.
 *
 * Safe to call multiple times — existing files are overwritten. The scenario
 * directory must exist before this function is called (created by DockerClient
 * before writing docker-compose.yml).
 *
 * @param scenarioDir    - Absolute path to <userData>/scenarios/<projectName>/.
 * @param projectName    - Docker Compose project name (used for Promtail volume refs).
 * @param controlSubnetPrefix - Optional override for the Control-zone (Level 3) subnet prefix
 *   (e.g., "10.201.20" when subnet auto-detection picked 10.201.20.0/24 instead
 *   of the default 10.200.20.0/24). InfluxDB is always .240 and Loki always .241
 *   within this prefix. Defaults to DEFAULT_CONTROL_PREFIX when omitted.
 */
export async function writeGrafanaProvisioning(
  scenarioDir: string,
  projectName: string,
  controlSubnetPrefix?: string
): Promise<void> {
  // Resolve the effective Control-zone prefix — use the caller-supplied resolved value when
  // subnet auto-detection chose a non-default range, otherwise use the static default.
  const controlPrefix = controlSubnetPrefix ?? DEFAULT_CONTROL_PREFIX
  // .240–.249 are reserved for system services; user devices start at .10
  const INFLUXDB_IP = `${controlPrefix}.240`
  const LOKI_IP = `${controlPrefix}.241`
  // ── Create directory tree ───────────────────────────────────────────────────
  const grafanaDatasourcesDir = join(scenarioDir, 'grafana', 'provisioning', 'datasources')
  const grafanaDashboardsProvDir = join(scenarioDir, 'grafana', 'provisioning', 'dashboards')
  const grafanaDashboardsDir = join(scenarioDir, 'grafana', 'dashboards')
  const promtailDir = join(scenarioDir, 'promtail')

  await Promise.all([
    mkdir(grafanaDatasourcesDir, { recursive: true }),
    mkdir(grafanaDashboardsProvDir, { recursive: true }),
    mkdir(grafanaDashboardsDir, { recursive: true }),
    mkdir(promtailDir, { recursive: true })
  ])

  // ── Grafana datasource provisioning ────────────────────────────────────────
  // Explicit UIDs are required so the dashboard JSON can reference them by a
  // known value. Without explicit UIDs, Grafana auto-generates them and the
  // dashboard JSON would have non-matching references.
  const datasources = {
    apiVersion: 1,
    datasources: [
      {
        name: 'InfluxDB',
        uid: 'otflab-influxdb',
        type: 'influxdb',
        url: `http://${INFLUXDB_IP}:8086`,
        database: 'otflab',
        isDefault: true,
        editable: true,
        jsonData: { httpMode: 'GET' }
      },
      {
        name: 'Loki',
        uid: 'otflab-loki',
        type: 'loki',
        url: `http://${LOKI_IP}:3100`,
        isDefault: false,
        editable: true
      }
    ]
  }
  await writeFile(join(grafanaDatasourcesDir, 'otflab.yaml'), yaml.dump(datasources), 'utf-8')

  // ── Grafana dashboard provider provisioning ─────────────────────────────────
  // Tells Grafana to watch /var/lib/grafana/dashboards (the volume-mounted dir)
  // for JSON dashboard files and refresh every 30 seconds.
  const dashboardProvider = {
    apiVersion: 1,
    providers: [
      {
        name: 'ICS Lab',
        orgId: 1,
        type: 'file',
        disableDeletion: false,
        updateIntervalSeconds: 30,
        allowUiUpdates: true,
        options: {
          path: '/var/lib/grafana/dashboards',
          foldersFromFilesStructure: false
        }
      }
    ]
  }
  await writeFile(
    join(grafanaDashboardsProvDir, 'otflab.yaml'),
    yaml.dump(dashboardProvider),
    'utf-8'
  )

  // ── ICS Lab Overview dashboard JSON ────────────────────────────────────────
  // Two log panels: Suricata IPS alerts and Zeek network analysis.
  // Both panels target the provisioned Loki datasource (uid: otflab-loki).
  // LogQL expressions filter by the `job` label set by Promtail's scrape config.
  await writeFile(
    join(grafanaDashboardsDir, 'ics-overview.json'),
    JSON.stringify(buildIcsDashboard(), null, 2),
    'utf-8'
  )

  // ── Promtail configuration ─────────────────────────────────────────────────
  // Promtail reads Suricata EVE JSON and Zeek logs from named Docker volumes
  // (shared via compose volume mounts) and ships them to the Loki HTTP endpoint.
  //
  // Pipeline stages parse Suricata's EVE JSON to extract the event_type label
  // (e.g., "alert", "dns", "http") so students can filter in Grafana.
  //
  // The positions file tracks how far into each log file Promtail has read so
  // restarts don't re-ship old entries.
  const promtailConfig = {
    server: { http_listen_port: 9080, grpc_listen_port: 0 },
    positions: { filename: '/tmp/positions.yaml' },
    // batchwait halved from the 1 s default to reduce the lag between Suricata/Zeek
    // writing a log line and it appearing in Grafana and the Live Logs panel.
    clients: [
      { url: `http://${LOKI_IP}:3100/loki/api/v1/push`, batchwait: '500ms', batchsize: 524288 }
    ],
    scrape_configs: [
      {
        job_name: 'suricata',
        static_configs: [
          {
            targets: ['localhost'],
            labels: {
              job: 'suricata',
              scenario: projectName,
              // Promtail __path__ selects files to tail
              __path__: '/var/log/suricata/eve.json'
            }
          }
        ],
        pipeline_stages: [
          // Parse the EVE JSON record to extract indexed fields.
          // alert.category uses dot-notation to reach the nested alert object —
          // populated only on alert events, empty string on all other event types.
          {
            json: {
              expressions: {
                event_type: 'event_type',
                src_ip: 'src_ip',
                dest_ip: 'dest_ip',
                proto: 'proto',
                alert_category: 'alert.category'
              }
            }
          },
          // Promote parsed fields to Loki stream labels so they're queryable
          // without needing a full JSON parse in every LogQL query.
          // alert_category is only set on alert events; empty on dns/http/flow/stats.
          { labels: { event_type: '', proto: '', alert_category: '' } }
        ]
      },
      {
        job_name: 'zeek',
        static_configs: [
          {
            targets: ['localhost'],
            labels: {
              job: 'zeek',
              scenario: projectName,
              // Zeek's standalone CLI accepts only one -i per process, so
              // entrypoint.sh runs one Zeek worker per host bridge interface,
              // each in its own /var/log/zeek/<iface>/ working directory (no
              // `current/` subdirectory — that is a zeekctl-managed deployment
              // convention, not standalone). The double-star glob picks up every
              // worker's log set.
              __path__: '/var/log/zeek/**/*.log'
            }
          }
        ]
      }
    ]
  }
  await writeFile(join(promtailDir, 'config.yaml'), yaml.dump(promtailConfig), 'utf-8')
}

/**
 * Builds the ICS Lab Overview Grafana dashboard object.
 *
 * Returns a plain JavaScript object that can be JSON.stringify'd into a Grafana
 * dashboard JSON file. The dashboard uses Grafana v10 schema (schemaVersion: 38)
 * and references the provisioned Loki datasource by its explicit UID.
 *
 * Layout (24-column grid):
 *   Row 0  y=0  h=4  : Stats row — total alerts | alert rate sparkline | top category
 *   Row 1  y=4  h=14 : Formatted alerts (left) | Zeek connections (right)
 *   Row 2  y=18 h=10 : All Suricata events (full width, collapsed by default)
 *
 * The formatted alerts panel uses LogQL line_format to produce readable one-liners
 * instead of dumping raw EVE JSON, e.g.:
 *   [2] ICS-SIM Modbus port scan detected | 10.200.60.10:54321 → 10.200.10.10:502 (TCP)
 */
function buildIcsDashboard(): object {
  /** Common datasource reference for all Loki panels. */
  const lokiDs = { type: 'loki', uid: 'otflab-loki' }

  // LogQL that formats a Suricata alert as a readable one-liner.
  //
  // Design: use event_type="alert" in the stream selector (Promtail labels it) so no
  // intermediate | json + filter chain is needed. A single | json stage extracts both
  // top-level fields (src_ip, proto…) and the nested alert.signature / alert.severity
  // fields simultaneously — this avoids the silent entry-drop that occurs when two
  // chained | json stages interact in some Loki versions. alert_category is already a
  // Promtail stream label so it's available in line_format without extraction.
  const alertsFormattedExpr =
    '{job="suricata", event_type="alert"}' +
    ' | json sig="alert.signature", sev="alert.severity",' +
    ' src_ip="src_ip", src_port="src_port", dest_ip="dest_ip", dest_port="dest_port", proto="proto"' +
    ' | line_format `[{{.sev}}] {{.sig}} | {{.src_ip}}:{{.src_port}} → {{.dest_ip}}:{{.dest_port}} ({{.proto}}) [{{.alert_category}}]`'

  return {
    id: null,
    uid: 'ics-overview',
    title: 'ICS Lab Overview',
    description: 'Live Suricata IPS alerts and Zeek network analysis for the running scenario.',
    tags: ['ics', 'scada', 'security', 'suricata', 'zeek'],
    timezone: 'browser',
    schemaVersion: 38,
    version: 2,
    refresh: '5s',
    time: { from: 'now-1h', to: 'now' },
    fiscalYearStartMonth: 0,
    graphTooltip: 0,
    links: [],
    panels: [
      // ── Row 0: Stats ──────────────────────────────────────────────────────

      // Total alert count — instant count of all alert events in window
      {
        id: 10,
        type: 'stat',
        title: 'Total Alerts',
        description: 'Count of Suricata alert events in the selected time window.',
        gridPos: { h: 4, w: 4, x: 0, y: 0 },
        datasource: lokiDs,
        options: {
          // fields:'' (all fields) so Grafana finds the numeric field regardless of
          // what the Loki datasource names it in the returned data frame. lastNotNull
          // on an instant query returns the single scalar value the query produces.
          reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false },
          orientation: 'auto',
          textMode: 'auto',
          colorMode: 'background',
          graphMode: 'none',
          justifyMode: 'center'
        },
        fieldConfig: {
          defaults: {
            color: { mode: 'thresholds' },
            thresholds: {
              mode: 'absolute',
              steps: [
                { color: 'green', value: null },
                { color: 'yellow', value: 1 },
                { color: 'red', value: 10 }
              ]
            }
          }
        },
        targets: [
          {
            datasource: lokiDs,
            editorMode: 'code',
            expr: 'sum(count_over_time({job="suricata", event_type="alert"}[$__range]))',
            queryType: 'instant',
            refId: 'A'
          }
        ]
      },

      // Alert rate over time — sparkline bar chart
      {
        id: 11,
        type: 'timeseries',
        title: 'Alert Rate',
        description:
          'Suricata alerts per Grafana time interval. Spikes correspond to attack bursts.',
        gridPos: { h: 4, w: 12, x: 4, y: 0 },
        datasource: lokiDs,
        options: {
          legend: { displayMode: 'hidden', placement: 'bottom' },
          tooltip: { mode: 'single', sort: 'none' }
        },
        fieldConfig: {
          defaults: {
            color: { mode: 'fixed', fixedColor: 'red' },
            custom: { drawStyle: 'bars', fillOpacity: 80, lineWidth: 0 }
          }
        },
        targets: [
          {
            datasource: lokiDs,
            editorMode: 'code',
            // count_over_time with $__interval gives alert counts per Grafana time
            // bucket. rate([1m]) returns alerts-per-second fractions that render as
            // near-zero values when alerts arrive in short bursts, making the chart
            // appear empty. count_over_time produces a visible spike for each burst.
            expr: 'sum(count_over_time({job="suricata", event_type="alert"}[$__interval]))',
            queryType: 'range',
            legendFormat: 'alerts',
            refId: 'A'
          }
        ]
      },

      // Alert breakdown by category label (set by Promtail pipeline)
      {
        id: 12,
        type: 'piechart',
        title: 'Alerts by Category',
        description: 'Distribution of Suricata alert categories in the selected time window.',
        gridPos: { h: 4, w: 8, x: 16, y: 0 },
        datasource: lokiDs,
        options: {
          // fields:'' (all fields) is required here. The instant query path sets
          // fields:'Value', which causes Grafana to drop the series label metadata and
          // display "Value #A" instead of the actual alert_category string.
          // Using a range query + calcs:['sum'] avoids that: Grafana builds a proper
          // labeled time series per category, sums each to one number, and uses the
          // legendFormat to name each pie slice.
          reduceOptions: { calcs: ['sum'], fields: '', values: false },
          legend: { displayMode: 'list', placement: 'right' },
          pieType: 'donut',
          tooltip: { mode: 'single' }
        },
        targets: [
          {
            datasource: lokiDs,
            editorMode: 'code',
            // Range query so Grafana builds a labeled time series per alert_category.
            // $__interval buckets the time range into Grafana's auto step; calcs:['sum']
            // collapses the buckets into one total per category for the pie slice value.
            expr: 'sum by (alert_category) (count_over_time({job="suricata", event_type="alert"}[$__interval]))',
            queryType: 'range',
            legendFormat: '{{alert_category}}',
            refId: 'A'
          }
        ]
      },

      // ── Row 1: Main detail panels ─────────────────────────────────────────

      // Formatted Suricata alerts — readable one-liners via line_format
      {
        id: 1,
        type: 'logs',
        title: 'Suricata — Alerts',
        description:
          'Formatted alert log: [severity] rule name | src → dst (proto) [category]. ' +
          'Click a line to expand the raw EVE JSON. Edit the LogQL in Explore for custom filters.',
        gridPos: { h: 14, w: 14, x: 0, y: 4 },
        datasource: lokiDs,
        options: {
          dedupStrategy: 'none',
          enableLogDetails: true,
          // prettifyLogMessage applies to the raw detail view, not the formatted line
          prettifyLogMessage: true,
          showLabels: false,
          showTime: true,
          sortOrder: 'Descending',
          wrapLogMessage: false
        },
        targets: [
          {
            datasource: lokiDs,
            editorMode: 'code',
            expr: alertsFormattedExpr,
            queryType: 'range',
            refId: 'A'
          }
        ]
      },

      // Zeek network connections
      {
        id: 2,
        type: 'logs',
        title: 'Zeek — Network Analysis',
        description:
          'Zeek protocol analyzer logs (conn.log, dns.log, modbus.log, dnp3.log). ' +
          'Each file is tagged with a filename label by Promtail.',
        gridPos: { h: 14, w: 10, x: 14, y: 4 },
        datasource: lokiDs,
        options: {
          dedupStrategy: 'none',
          enableLogDetails: true,
          prettifyLogMessage: false,
          showLabels: true,
          showTime: true,
          sortOrder: 'Descending',
          wrapLogMessage: true
        },
        targets: [
          {
            datasource: lokiDs,
            editorMode: 'code',
            expr: '{job="zeek"}',
            queryType: 'range',
            refId: 'A'
          }
        ]
      },

      // ── Row 2: Raw event stream (full width) ──────────────────────────────

      // Full Suricata EVE stream — dns, http, tls, flow, stats, alerts
      {
        id: 3,
        type: 'logs',
        title: 'Suricata — All Events (raw EVE JSON)',
        description:
          'Complete Suricata EVE stream including dns, http, tls, flow, stats and alerts. ' +
          'Use event_type label filter to narrow: | event_type=`dns` etc.',
        gridPos: { h: 10, w: 24, x: 0, y: 18 },
        datasource: lokiDs,
        collapsed: false,
        options: {
          dedupStrategy: 'none',
          enableLogDetails: true,
          prettifyLogMessage: true,
          showLabels: false,
          showTime: true,
          sortOrder: 'Descending',
          wrapLogMessage: false
        },
        targets: [
          {
            datasource: lokiDs,
            editorMode: 'code',
            // Exclude high-volume stats events from the default view
            expr: '{job="suricata"} | json | event_type != `stats`',
            queryType: 'range',
            refId: 'A'
          }
        ]
      }
    ]
  }
}

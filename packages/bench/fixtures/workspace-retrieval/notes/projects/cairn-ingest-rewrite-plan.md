# Cairn ingest rewrite plan

Owner: Priya N. Reviewers: Tomasz W, Joel M. Last updated July 2026. This is the long version of the plan; the one-page summary for leadership lives in the wiki.

## Why we are doing this

Cairn is the pipeline that receives telemetry from the field fleet (about 19,000 stations, each posting every 10 or 30 minutes), validates it, writes it to the time-series store, and feeds the customer dashboards. The original design from 2022 uses a hosted queue service. Three problems pushed us to rewrite it:

1. No replay. When ingest fails, the messages that were already acknowledged cannot be replayed, so we backfill from device-side buffers, which only hold about 6 hours of readings.
2. Message size limit. The hosted queue caps messages at 256 KB, and the new Marmot v3 probe batches readings that can exceed that at certain depths.
3. Cost. The bill passed $3,100 a month in April, and it scales with message count.

The January storm and the March outage (see the postmortem) made the replay problem concrete.

## Target architecture

Devices post to the edge gateway (`gw-edge-eu1` and `gw-edge-us1`), which authenticates the device certificate and forwards to a NATS JetStream cluster (`bus-01`, `bus-02`, `bus-03`, decided in ADR 0007). Four consumer groups read from the raw stream:

- validator: schema checks and unit normalization
- writer: batches into the time-series store
- alerter: threshold and offline detection for customer alerts
- archiver: writes compressed raw batches to object storage for cold replay

Validators emit rejected messages to `ingest-dlq`. A message is retried up to 5 times with exponential backoff before it lands there.

## Phases and dates

Phase 0, groundwork, finished 2026-06-12. Staging cluster built, load generator written, baseline measured at 4,000 messages a second sustained.

Phase 1, dual write, planned 2026-07-20 to 2026-08-14. The gateway writes to both the old queue and JetStream. Consumers on JetStream are shadow-only. We compare row counts in the store each night; the acceptance bar is under 0.01 percent difference over seven consecutive days.

Phase 2, cutover for the Wasatch group, planned the week of 2026-08-24. This is the smallest fleet and is the one most tolerant of a short outage.

Phase 3, cutover for the rest of the fleet in four waves, planned 2026-09-08 through 2026-10-02. Each wave is 25 percent of the fleet by device ID hash. We pause between waves for two business days.

Phase 4, decommission the hosted queue, planned 2026-10-19, after a two-week quiet period.

## Capacity numbers

Peak ingest today is about 2,600 messages a second during the morning upload window. The staging cluster handled 4,000 sustained and 6,500 for short bursts of up to 90 seconds before p99 latency exceeded 2 seconds. Three nodes with 8 vCPUs and 32 GB each are enough with headroom. Storage for 72 hours of raw retention is about 1.1 TB per node with three replicas.

Replay of a 6-hour window took 11 minutes in staging when the writer consumer was scaled to eight instances. With four instances it took 21 minutes.

## Risks and mitigations

- Cluster certificate expiry. JetStream mTLS certificates have a 90-day lifetime. Tomasz owns rotation and will add an alert 21 days before expiry.
- Duplicate delivery during cutover. Messages carry a device sequence number; the writer deduplicates on `(station_id, seq)`. This was the cause of two bugs found in staging, both fixed.
- Operational unfamiliarity. Nobody on the team has run JetStream in production. We will hold a game day on 2026-08-06 where we kill nodes on purpose and rehearse the recovery steps.
- Gateway CPU. TLS termination in the gateway got slower with the larger certificate chain. Measured 7 percent more CPU per request. Acceptable.

## Open questions

1. Retention for the dead-letter stream. Priya proposes 14 days; Tomasz wants 30 because customer support sometimes asks about messages from weeks ago. Not resolved.
2. Whether the archiver should write Parquet or compressed JSON lines. Parquet is better for analytics; JSON lines are simpler to replay. Leaning Parquet with a replay tool that reads it.
3. Do we expose replay to customers? Marcus thinks some enterprise customers would pay for it. Out of scope for the rewrite.

## What done looks like

- Old hosted queue is off and its bill is gone
- Replay of any 72-hour window is a documented runbook step
- p99 end-to-end latency from gateway to dashboard under 5 seconds at peak
- On-call has a runbook for each of the four consumer groups
- No increase in dashboard staleness reports from customers during cutover

## Decision log for the rewrite

2026-05-19: adopt NATS JetStream (ADR 0007).
2026-06-02: dedupe on `(station_id, seq)` rather than a content hash; hashes were 15 percent slower and could collide on identical zero readings.
2026-06-23: archive format is Parquet, pending the retention discussion.
2026-07-07: consumers use pull-based subscriptions, not push, so backpressure is explicit.
2026-07-14: dual write window extended from two weeks to four, after Luis asked for more soak time.

## Notes from the phase 0 review

Joel asked what happens if the bus cluster loses two of three nodes. Answer: the stream becomes unavailable for writes, the gateway buffers up to 5 minutes in memory per instance and then starts returning HTTP 503 so devices retry on their own schedule. Devices already hold 6 hours of readings so a short outage is survivable. Tomasz wants the buffer on local disk instead of memory; the gateway owner thinks that adds more risk than it removes. We agreed to measure disk write latency before deciding.

Priya also noted that the dashboards read from the time-series store, not the bus, so they are insulated except for lag. That means customer-visible impact of a bus outage is staleness, not missing data, provided it is shorter than the device buffer.

## Staffing and communication

Priya is the technical lead and spends roughly 70 percent of her week on the rewrite through October. Tomasz spends about one day a week on cluster operations and certificate plumbing. Hana contributes the firmware side: the device sequence number field must be present in every uplink from firmware 4.2 onward, and stations on older firmware get a synthetic sequence number assigned at the gateway, which makes deduplication weaker for them. Luis owns the comparison scripts for the dual-write window and has agreed to review row counts each morning at 09:00.

Weekly status goes into the platform sync notes. A short customer-safe summary will be sent by Marcus before each cutover wave so that account owners at ski areas and water districts know the dates. Marcus asked that no wave begin on a Friday or ahead of a long weekend; Priya agreed and moved wave 2 from September 18 to September 22 for that reason.

## Test checklist for each wave

1. Confirm the dead-letter stream is empty before starting.
2. Confirm the previous wave has run two quiet business days.
3. Take a baseline of dashboard freshness for ten sample accounts.
4. Move the next 25 percent of device IDs by changing the gateway routing table.
5. Watch consumer lag for 60 minutes with two people online.
6. Compare freshness for the same ten accounts after one hour.
7. Record the result in the wave log and tell support the wave is complete.

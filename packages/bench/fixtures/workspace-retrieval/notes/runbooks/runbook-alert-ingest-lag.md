# Runbook: alert INGEST_LAG_HIGH

Fires when the age of the newest row in the time-series store is more than 15 minutes behind the gateway clock for 10 minutes. Customers see stale dashboards. Severity: page.

## First checks
1. Open the Cairn dashboard, panel "Write freshness".
2. Check whether the gateway is receiving data: `cairnctl gw rate --region all`. If the rate is near zero, this is a device or network issue, not lag. Go to the gateway runbook.
3. Check writer consumer lag: `cairnctl consumers lag --group writer`.

## Common causes
- Writer pods crash-looping. Run `kubectl -n cairn get pods -l app=writer` and look for restarts. Fix: `kubectl -n cairn rollout restart deploy/writer`.
- Time-series store under heavy compaction. Check `ts-store-01` CPU. If above 90 percent for 20 minutes, ask the store owner (Tomasz) before restarting anything.
- Poisoned message. Lag grows but only one partition is stuck. Move it with `cairnctl dlq push --msg-id <id>`.

## Recovery
Scale writers temporarily: `kubectl -n cairn scale deploy/writer --replicas=8`. Replay speed is about 30,000 messages a minute per replica. Scale back to 4 once freshness is under 2 minutes.

## Escalation
If freshness is still above 15 minutes after 30 minutes of work, page the secondary and post in the incident channel. After 60 minutes, notify Marcus so support can send customer notices.

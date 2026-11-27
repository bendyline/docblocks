# Runbook: alert QUEUE_DEPTH_HIGH

Fires when the depth of `ingest-raw-02` exceeds 300,000 messages for 5 minutes. This alert predates the lag alert and watches the input side rather than the output. Severity: page between 07:00 and 22:00, ticket otherwise.

## First checks
1. Look at the Cairn dashboard panel "Queue depth".
2. Check whether intake spiked: `cairnctl gw rate --region all`. A morning upload window can produce a rate of 2,600 messages a second, which is normal.
3. Check validator health: `cairnctl consumers lag --group validator`.

## Common causes
- Validators stuck on a schema change. A new firmware field often causes this. Check `kubectl -n cairn logs deploy/validator --tail=200` for `ERR_SCHEMA_7`.
- Retry storm. Messages retry up to 5 times before landing in `ingest-dlq`. If the DLQ is growing, find the common error rather than draining it.
- Gateway burst after an outage. Many stations flush buffered readings at once. Let it drain unless depth passes 900,000.

## Recovery
- Add validators: `kubectl -n cairn scale deploy/validator --replicas=10`. Default is 5.
- If a bad schema is blocking, deploy the schema hotfix branch with `cairnctl schema push --hotfix`.
- Do not purge the queue. If depth passes 1.5 million, call Tomasz.

## Escalation
After 45 minutes without a falling depth trend, page the secondary. Notify Marcus if customer dashboards lag more than 30 minutes.

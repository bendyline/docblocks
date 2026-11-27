# Platform sync, March 11 2026

Attendees: Joel M, Priya N, Hana T, Luis R, Marcus E, Tomasz W (SRE, joining for the first time)

## Agenda
1. Beta cohort sizing (carried over)
2. Retry limits in Cairn
3. Support load

## Beta cohort
Luis made the case again for a larger cohort. Hana is fine with it as long as the rollback path is tested.

Decision: the beta cohort grows from 40 to 120 devices, with the extra 80 drawn from the Colorado snow-depth fleet. The firmware date stays April 14.

## Retry limits
Priya's proposal: lower the Cairn delivery retry ceiling from 9 attempts to 5. Nine attempts with exponential backoff meant a poisoned message could occupy a worker for almost 20 minutes. Tomasz agreed and asked for a dead-letter queue so nothing is silently dropped.

Decision: retry ceiling is 5 attempts, failures go to the dead-letter queue `ingest-dlq`, and an alert fires if the dead-letter queue exceeds 200 messages.

## Support load
Marcus says ticket volume was 61 last week, up from 44. Most are about the mobile app pairing screen, not hardware. Joel asked for a breakdown by app version before deciding whether to staff another contractor.

## Action items
- Priya: implement retry ceiling and DLQ by March 20
- Tomasz: add the DLQ alert rule to the on-call config
- Marcus: ticket breakdown by app version, due Friday
- Luis: select the 80 additional beta devices with Hana

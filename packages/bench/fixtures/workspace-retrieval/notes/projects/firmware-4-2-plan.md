---
tags: [firmware, plan, pika-3]
---
# Firmware 4.2 plan

Owner: Hana T. Goal: ship a radio driver rewrite plus the new low-power sampling mode for Pika-3 stations.

## Scope
- Rewritten LoRa driver with adaptive spreading factor
- "Quiet winter" sampling mode that cuts battery draw by roughly 30 percent below -10 C
- Fix for the clock drift bug (TKT-2188)
- Not in scope: certificate rotation (deferred to 4.3)

## Milestones

| Milestone | Date | Owner | Status |
| --- | --- | --- | --- |
| Feature freeze | 2026-02-20 | Hana T | done |
| 4.2-rc1 to bench | 2026-02-27 | Luis R | done |
| 4.2-rc2 to beta channel | 2026-03-06 | Hana T | done |
| Beta cohort expands to 120 | 2026-03-16 | Luis R | done |
| Release candidate sign-off | 2026-04-07 | Joel M | done |
| General availability | 2026-04-14 | Hana T | done |
| Post-release review | 2026-05-12 | Joel M | open |

## Risks
The duty-cycle regression (TKT-2231) is the main schedule risk. If it is not fixed by rc3 the release moves again.

## Rollback
Stations keep the previous image in the secondary slot for 14 days. See the OTA rollback runbook.

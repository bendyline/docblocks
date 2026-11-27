# Postmortem: ingest outage, March 26 2026

Status: final. Author: Priya N, with Tomasz W. Reviewed in the blameless review on April 2. Severity: SEV-1 (customer-visible data gap, more than 3 hours).

## Summary
On Thursday March 26 between 14:07 and 17:48 UTC, customer dashboards stopped showing new readings. The pipeline kept accepting data from stations, but the writer could not commit it to the time-series store. No data was permanently lost. Total impact window was 3 hours 41 minutes plus about 50 minutes of catch-up lag.

## Impact
- Dashboards stale for all 212 customer accounts
- Customer alerts for threshold and offline events were suppressed or late, which affected 41 accounts that had active alerts
- Support received 37 tickets in the window
- Tri-Valley and Ridgeline both called; Ridgeline noted they had made a road decision without current data
- The quarterly uptime figure for the data feed dropped to 99.71 percent

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 13:55 | Scheduled schema migration `0042_add_quality_flag` starts on `ts-store-01` |
| 14:07 | Writer commit latency exceeds 30 seconds; first writer timeouts |
| 14:12 | QUEUE_DEPTH_HIGH fires, primary acknowledges |
| 14:20 | Primary suspects gateway issue and spends 25 minutes there |
| 14:48 | Primary pages secondary; Tomasz joins |
| 15:10 | Tomasz finds the migration still holding an exclusive lock on the readings table |
| 15:32 | Migration cancel attempted; blocked behind long-running compaction |
| 16:15 | Compaction killed with approval from Tomasz; lock released |
| 16:20 | Writers recover; queue depth peaks at 1.9 million messages |
| 17:48 | Dashboard freshness back under 5 minutes |
| 18:40 | Queue fully drained |

## Root cause
The migration added a column with a default to a 4.1 billion row table. In the version of the store we run, this rewrites the table under an exclusive lock. It had been tested in staging against 40 million rows, where it took 11 seconds. Nobody extrapolated to production.

A contributing factor was the delivery retry policy: nine attempts with exponential backoff meant that each writer worker was occupied by a failing message for up to 20 minutes, reducing throughput even after the lock cleared.

## What went well
- No permanent data loss, because stations buffer 6 hours of readings.
- Tomasz's lock diagnosis was quick once he joined.
- Support's customer notice went out within 35 minutes of the first ticket.

## What went badly
- The primary spent 25 minutes investigating the gateway because the alert pointed at the input queue.
- The migration ran in business hours without a go/no-go check.
- Neither the status page nor the customers were told until 14:50.
- The runbook for QUEUE_DEPTH_HIGH did not mention checking for long-running locks on the store.

## Action items

| Item | Owner | Due | Ticket |
| --- | --- | --- | --- |
| Run all production migrations out of hours with a written plan | Tomasz W | 2026-04-15 | TKT-2310 |
| Test migrations against a 1 billion row clone | Priya N | 2026-05-01 | TKT-2311 |
| Lower retry ceiling to 5 with dead-letter queue | Priya N | 2026-03-20 (done) | TKT-2290 |
| Add INGEST_LAG_HIGH alert on output freshness | Tomasz W | 2026-04-10 | TKT-2312 |
| Add lock check to the runbook | Hana T | 2026-04-08 | TKT-2313 |
| Auto-post to status page when a SEV-1 is declared | Marcus E | 2026-05-15 | TKT-2314 |

## Lessons
Queue depth is an input-side symptom; freshness is what customers feel. The new INGEST_LAG_HIGH alert measures the right thing. We also learned that the rollback of a migration can be worse than the migration if long maintenance jobs share the table.

## Detail: the lock chain

The exclusive lock was held by the migration's `ALTER TABLE` statement. It was waiting for in-flight writes to drain, while the compaction job held a share lock it would not release for another 70 minutes. Because the migration was queued ahead of the writers, every new write queued behind it. That is why commit latency, not errors, was the first sign. Tomasz's query that found it was a lookup on the lock wait view sorted by wait duration.

## Detail: why the retry policy mattered

During the incident the validators kept retrying. A poisoned message does not exist here, but the effect was similar: each worker held one message in a backoff loop. With a nine-attempt ceiling the longest hold was 19 minutes 40 seconds. After the ceiling was lowered to 5, the longest hold dropped to about 4 minutes. The change had actually shipped a week before the outage, on March 19, but only to the validator; the writer still used the old policy. That gap is itself an action item: TKT-2315, make the policy a shared setting.

## Comms notes
First customer notice: 14:50 UTC, "We are investigating delayed readings." Second notice at 16:25 when writers recovered. Final notice at 18:45. Marcus thinks the second notice was too cheerful given the 50 minutes of lag still ahead. Rosalind called the Ridgeline and Tri-Valley contacts personally on March 27.

## Follow-up check, May 2026
TKT-2310, 2311, 2312, 2313, and 2315 are done. TKT-2314 slipped to June because the status page vendor changed its API. All migrations since April 15 have run out of hours. The largest, `0047_partition_readings`, took 38 minutes on a clone and 41 in production.

## Open questions
Should the time-series store have a read replica for dashboards so a write-lock cannot take the dashboards down? Tomasz estimates $1,900 a month. Not decided.

## Appendix: customer-facing numbers

Of the 212 affected accounts, 17 opened a ticket, and 9 of those asked for a credit. Finance approved credits for the 9 totaling $3,870, calculated as one day of service per account at its contract rate. Two enterprise customers requested a written root cause statement; Marcus sent a short version on April 6, omitting hostnames and internal ticket numbers. No customer cancelled because of the outage, although Ridgeline said it would weigh the outage at its next renewal.

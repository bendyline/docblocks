# On-call handbook

Maintained by Tomasz W. Applies to the platform on-call rotation (primary and secondary). Read it once before your first shift and skim it every time you are on.

## What on-call means here

On-call is a week from Monday 10:00 to the next Monday 10:00. The primary receives all pages; the secondary only receives a page if the primary has not acknowledged within 10 minutes, or if the primary asks for help. You are not expected to fix everything alone; you are expected to answer, assess, and escalate in good time.

Response expectations: acknowledge a page within 10 minutes during the day (07:00 to 22:00) and within 15 minutes overnight. Overnight pages are limited to SEV-1 and SEV-2 alerts; everything else becomes a ticket for the morning.

Compensation: one comp day for each primary week, taken within the following 30 days. A stipend of $350 per primary week was proposed in February and is awaiting approval from leadership.

## Severity levels

- SEV-1: customer data not arriving or not visible for more than 30 minutes for many customers, or any security incident. Page everyone needed. Declare in the incident channel, start a timeline doc.
- SEV-2: one component of the customer experience down (dashboard, API, alerts), with data still safe. Primary leads.
- SEV-3: degraded but working. Ticket, handle in business hours.

Who declares: the primary on call. When in doubt, declare higher and downgrade later.

## Tools and access

- Pager app: install it before your shift and test with `pagerctl test --me`.
- `cairnctl`: the command line for the ingest pipeline. Authenticate with `cairnctl login --env prod`. Tokens last 8 hours.
- `kubectl` context: `tarnwell-prod`. Namespaces: `cairn`, `dash`, `ota`.
- `otactl`: for firmware campaigns.
- Status page: edit from the vendor console; credentials in the team vault entry "status-page-admin".
- Break-glass access to the time-series store is through `ts-store-01` using the `breakglass` role and requires a second person to approve in the pager app.

## The first ten minutes

1. Acknowledge the page. Say so in the incident channel with your name.
2. Open the matching runbook. There are runbooks for INGEST_LAG_HIGH, QUEUE_DEPTH_HIGH, DASH_PROBE_FAIL, and OTA rollback.
3. Decide the severity. Write it in the channel.
4. Start a timeline doc in the shared drive. One line per action with timestamps in UTC.
5. If unsure after 10 minutes, page the secondary.

## Communication

Customer communication goes through Marcus E (or his backup, Ines V). The primary supplies facts; support writes and sends. Never promise a fix time. Use plain language: "We are investigating delayed readings," not internal queue names.

Update cadence for SEV-1: every 30 minutes in the channel and on the status page, even if there is no new information.

## Handoff

The outgoing primary posts a handoff note in the channel by Monday 10:00 covering: open incidents, noisy alerts, changes in flight, and anything scheduled this week (migrations, certificate rotations, rollouts). The incoming primary reads it, replies "got it", and takes the pager. The handoff meeting is 15 minutes at most.

Known hazards for the next handoff as of this writing: the Cairn dual-write window is running through mid-August, so queue depth alerts may fire twice per event. JetStream cutover waves begin on September 8 and the primary should expect higher alert volume for the first two business days of each wave.

## Hostnames and what they are

| Host | Purpose |
| --- | --- |
| `gw-edge-us1` | Gateway for devices in the Americas |
| `gw-edge-eu1` | Gateway for devices in Europe |
| `ts-store-01` | Time-series store primary |
| `dash-lb-01` | Dashboard and API load balancer |
| `bus-01`, `bus-02`, `bus-03` | JetStream nodes |
| `ota-cdn-1` | Firmware image distribution |

## Things that look scary but are normal

- The morning upload window between 12:00 and 13:30 UTC produces up to 2,600 messages a second. Queue depth may reach 200,000 briefly.
- A handful of stations always show offline in quiet winter mode; the alert is known to false-fire for them.
- The `ota-cdn-1` cache hit rate drops below 50 percent right after a release. That is expected.

## Things that look fine but are not

- A flat freshness graph. If no new rows appear at all, the writer may be down while the gateway is healthy.
- A green dashboard while support tickets rise. Tickets are a sensor; Marcus watching the queue caught the August outage before the alert did.
- A retry count that is rising on only one consumer group.

## Rules for risky changes during your week

No migrations, certificate rotations, or large OTA campaigns during the primary's week without telling the primary first. Production migrations run out of hours with a written plan. This rule was written after the March ingest outage.

## After an incident

Write a postmortem for any SEV-1 or SEV-2 within five business days. Use the blameless template: summary, impact, timeline, root cause, what went well, what went badly, action items with owners and tickets. Present it at the Thursday reliability review. The postmortems of March 26 and August 11 are good examples; compare their different root causes before you assume the same fix applies.

## Self-care

If you were paged overnight, start late the next day. Tell your manager; do not make it a discussion. If a shift is unusually painful, say so in the retrospective, because pager fatigue was one reason Priya nearly burned out in the January storm.

## Changing this document

Edit directly and tell the channel. Keep it short. If it grows past what a new person reads in 20 minutes, split it.

## Appendix: escalation contacts

- Firmware questions during an OTA rollout: Hana T (primary), Luis R (backup)
- Time-series store break-glass approvals: Tomasz W, then Priya N
- Customer notices and status page: Marcus E, then Ines V
- Executive notification for any SEV-1 over 60 minutes: Joel M, who informs Rosalind K
- Security incidents: Tomasz W and the retained consultant, Ingrid S, whose number is in the vault entry "ir-retainer"

Phone numbers are intentionally not written here. The vault entry holds the current ones and is reviewed each quarter. If you cannot reach anyone, leave a message and keep working the runbook; do not wait.

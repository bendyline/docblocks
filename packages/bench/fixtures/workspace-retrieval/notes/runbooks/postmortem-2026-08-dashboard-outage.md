# Postmortem: dashboard unreachable, August 11 2026

Status: final. Author: Tomasz W. Severity: SEV-2. Customer data was still arriving and being stored; only the web dashboard and customer API were unreachable.

## Summary
On Tuesday August 11 from 06:32 to 08:44 UTC the dashboard and API returned TLS errors to browsers and integrations. Duration: 2 hours 12 minutes. Stations were unaffected.

## Timeline (UTC)

| Time | Event |
| --- | --- |
| 06:32 | TLS certificate on `dash-lb-01` expires |
| 06:41 | First support ticket (SUP-9772) from Cedar Flats Orchard |
| 06:58 | Synthetic probe alert DASH_PROBE_FAIL fires but is sent to a muted channel |
| 07:30 | Marcus notices the ticket count and pages the primary |
| 07:52 | Primary identifies the expired certificate |
| 08:20 | New certificate issued; automatic renewal job found disabled |
| 08:44 | Load balancer reloaded; dashboard healthy |

## Root cause
Certificate renewal for `dash-lb-01` was handled by a cron job on a host that was decommissioned in June. Nobody moved the job. The second line of defense, the synthetic probe alert, was routed to a channel muted after a noisy week in July.

## Impact
- 214 support contacts, 29 of them from API integrators
- Tri-Valley's nightly SFTP export unaffected
- One customer, Harbor Point Marina, cancelled a demo with a harbor board

## Actions

| Item | Owner | Ticket |
| --- | --- | --- |
| Inventory every certificate with an expiry date and owner | Tomasz W | TKT-2688 |
| Move renewal to the load balancer's managed cert feature | Tomasz W | TKT-2689 |
| Unmute DASH_PROBE_FAIL and route to the pager | Priya N | TKT-2690 |
| Add a 30-day and 7-day certificate expiry alert | Tomasz W | TKT-2691 |

## Compare to March
This outage was shorter and entirely on the customer-facing side, with a different cause (an expired certificate, not a database lock). The common thread is that the right alert existed but did not reach a human quickly.

# Account notes: Tri-Valley Water District

Running notes on our largest public-sector customer. Contacts: Samir A (hydrology program lead), Corinne F (procurement), Willem D (field technician supervisor). Account owner on our side: Marcus E. Executive sponsor: Rosalind K.

## Snapshot
Tri-Valley uses 212 Marmot soil probes and 38 Pika-3 stations across three watersheds to forecast spring snowmelt runoff and irrigation releases. They are on a three-year contract that began on 2025-07-01, billed annually at $186,000, with a 3 percent annual escalator.

## History

### Onboarding, summer 2025
Installation was done by the district's own technicians with our remote support. The first 60 probes were installed in July. The district insisted on on-premises documentation of calibration offsets, which we supplied as PDFs. The pairing process on the mobile app was painful for their older Android phones, which helped drive the app engineer discussion.

### The calibration dispute, November 2025
Samir noticed that soil moisture readings from 17 probes in the Kellogg Basin were consistently about 4 percentage points drier than their gravimetric samples. We investigated and found those 17 probes came from a manufacturing lot where the probe tip was cut 3 mm short. We replaced all 17 under warranty at a cost to us of about $2,600 and agreed on a replacement schedule within three weeks. This was handled well; Samir wrote a thank-you.

### Winter 2026
Few issues. The district asked for a custom dashboard view that combines probe depths into one root-zone moisture number. We built it as a configuration, not custom code, delivered in February.

## Procurement and renewal facts
- Purchase orders must be issued through Corinne; no one else can commit district funds.
- The district's fiscal year starts July 1, so budget asks must land by February.
- Expansion option: up to 120 additional probes at $168 each if ordered before 2026-12-31. Corinne said the board would consider it at the November meeting.
- The district requires a SOC report or equivalent. We delivered our security review summary in May 2026 instead, with Ingrid S's findings and remediation dates redacted to the headline level. Corinne accepted it.

## People notes
Samir is technical and impatient with sales language; lead with data. Corinne is formal and wants everything in writing. Willem prefers phone calls and is the first to notice field problems. He mentioned in June that his team is short two technicians and may delay the autumn probe installs.

## Technical details worth remembering
The district's station IDs begin with `TV-` and probes are numbered `TVP-0001` through `TVP-0212`. Their data goes through a dedicated export that pushes a nightly CSV to their SFTP server at 02:30 local time. We keep a copy in object storage for 90 days.

Their largest single request is for hourly rather than 30-minute uploads on the probe network to save battery. Hana says this is available in firmware 4.2 with a configuration flag and will cut battery use by around 18 percent. We switched 40 probes in Kellogg Basin on 2026-05-27 as a trial.

## Call log

### 2026-02-10 quarterly call
Samir wanted a forecast accuracy report. We promised one by March. Delivered March 24. Spring runoff prediction error was within 6 percent for two of three watersheds; the third was off by 11 percent because of a missing probe cluster at high elevation.

### 2026-05-27 quarterly call
We discussed the probe battery trial, the expansion option, and a request from Samir for an API endpoint that returns root-zone moisture for a given date range. Priya said the endpoint can ship in API 2.20. Samir asked for a sandbox key; Marcus issued it the same day.

### 2026-08-19 quarterly call
Samir reported that the nightly SFTP export missed three nights in July, all after a certificate change on their server. We changed our host key handling and replayed the missing nights. Corinne said the board approved the expansion order of 80 additional probes, to be placed in November under the $168 price. That order has not yet arrived.

## Risks
- The contract has an out clause if uptime of the data feed falls under 99.5 percent in any quarter. Q1 2026 was 99.71 percent. The March ingest outage was a near miss for that quarter and we have not told the district how close it was.
- Staff turnover at the district. Samir mentioned he may take a role at another agency within a year.
- Competitor pricing. A rival quoted Samir $142 per probe for a comparable unit, though without the same accuracy specification.

## Next actions
1. Confirm the 80-probe expansion PO with Corinne and book manufacturing.
2. Ask Willem whether the autumn installation schedule is slipping.
3. Offer Samir an early look at the Cairn rewrite's freshness tool.
4. Review the uptime clause with Rosalind before the next renewal talk.
5. Send the root-zone endpoint documentation when API 2.20 releases.

## Relationship map
Rosalind talks to the district's general manager twice a year. Marcus owns everything day to day. Hana is a trusted technical contact for Samir and has visited the Kellogg Basin once. If an incident occurs, Samir should be told by a human within an hour, not by an automated email; this was explicitly requested after the November episode.

## Appendix: how the pricing was built

The original quote in spring 2025 was $176,000 per year for 200 probes and 38 stations, with a $10,000 premium for dedicated support responsiveness (four business-hour response and a named contact). The district negotiated the support premium down by half because they already have a field team, which is how the number ended at $186,000 after the bundle of 12 spare probes was added. The 3 percent escalator applies on each anniversary of 2025-07-01, so the second-year billing in July 2026 was $191,580. Marcus has a spreadsheet that reconciles each invoice line; Corinne asks for it every year.

Another detail from procurement: invoices must reference the district's contract number TVWD-2025-0417 or they are rejected by accounts payable, and payment terms are net 45, not our usual net 30. We lost nine days in October 2025 because an invoice went out without the number.

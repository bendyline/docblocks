# Q1 planning offsite, February 17 2026

Held in the big conference room with the whiteboards still up from the hardware review. Present: Rosalind K, Joel M, Hana T, Priya N, Marcus E, Dev P, Luis R, Tomasz W (remote), and Neve A from finance for the budget block. These are my raw notes; I cleaned up the action items at the end.

## Morning block: where we are

Rosalind opened with the year in one slide: we ended 2025 with 36 employees, $8.4M in revenue, and a field fleet of about 19,000 active stations. The goal for 2026 is 40 people by midyear and about $11M in revenue. She was blunt that growth depends on two things: the Marmot soil probe v3, and not having another winter where the ingest pipeline falls over during a storm.

Joel reviewed the engineering backlog. There are 212 open tickets, of which 31 are tagged customer-facing. He proposed freezing new feature work for three weeks in March to burn down the oldest 40, and the room mostly agreed. Hana was concerned that a freeze collides with the firmware 4.2 feature freeze on February 20. Joel's answer: firmware is excluded from the backlog freeze.

Marcus presented support numbers for the last quarter. Median first response was 3.4 hours, which is fine, but the long tail is ugly: 9 percent of tickets waited over two days, almost all of them involving the mobile app pairing flow. He asked for a dedicated app engineer. Rosalind said that is a conversation for the hiring plan, not today.

## Midday: product priorities

We ranked the candidate projects on a whiteboard using a rough value-versus-effort grid. The outcome, top to bottom:

1. Firmware 4.2 (radio driver rewrite and quiet-winter mode)
2. Cairn ingest rewrite (move off the hosted queue, add replay)
3. Marmot v3 soil probe
4. Customer API 2.x cleanup
5. Snow-depth sensor for avalanche forecasters (explicitly unfunded, revisit in Q3)

Dev raised a supply concern about the LoRa modules. Lead times from our current supplier have stretched from 10 weeks to 16. He recommended qualifying a second source in Q2. Nobody objected. Hana volunteered to run the technical evaluation of any second-source module.

There was a long discussion about whether to keep the Wasatch test group as the only pre-release fleet. Luis argued the group is too small and too homogeneous: all Pika-3 units at similar altitudes. Tomasz suggested using the Colorado snow-depth fleet as a second group. We did not decide this; it goes to the platform sync.

## Afternoon: budget and headcount

Neve walked through the Q1 budget. The company is allowed to spend up to $1.46M on cost of goods and operations this quarter, and the plan is currently $1.38M, leaving a little headroom. The big items:

- Cloud hosting: $41,000 a quarter, trending up about 6 percent per month because of ingest volume
- Contract manufacturing: $512,000
- Payroll and benefits: $690,000

Decision: the Marmot v3 tooling budget is $38,400, approved with a condition that the supplier hold price through September. If the supplier will not hold price, Dev brings it back for another vote. Neve will track tooling spend on a separate line so it does not blur into manufacturing.

Headcount: two embedded engineers, one support hire, one SRE already filled (Tomasz). The app engineer request is deferred to Q3 pending the support ticket breakdown.

Rosalind asked about the office lease. The current lease ends in November 2026. The landlord offered a two-year renewal with a 4 percent increase. Decision: Joel and Rosalind will tour two alternative spaces before March 31 and decide in April.

## Late afternoon: reliability

Tomasz presented an incident review of the January storm, when the queue backed up. His recommendation: alert on queue depth at 300,000 messages rather than 900,000, and cap retries. Priya objected to capping retries without a dead-letter queue. They agreed to bring a joint proposal to a platform sync rather than settle it here.

We also talked about whether on-call should be paid. Currently on-call is voluntary with comp time. Rosalind will bring a stipend proposal to the leadership team: $350 per on-call week was the number floated.

## Other topics

- Conference budget: one conference per engineer
- Winter field visit: Luis and Hana to inspect six stations in the Colorado test fleet in March
- Customer advisory call: Marcus will invite five customers to a quarterly call starting in May
- Swag: no

## Action items

- Joel: run the three-week backlog burn-down, starting March 2, excluding firmware
- Hana: scope a second-source LoRa module evaluation
- Dev: confirm Marmot v3 tooling price hold in writing
- Neve: separate tooling line in the budget sheet
- Tomasz and Priya: joint proposal on queue alerts and retries for a platform sync
- Rosalind: draft on-call stipend proposal
- Marcus: ticket breakdown by app version, then revisit the app engineer request
- Joel and Rosalind: tour two office spaces before March 31

## My reflections

The best part of the day was the whiteboard ranking, because it forced people to accept that the snow-depth sensor is not happening this half. The weakest part was budget time; Neve had slides but several people were reading email. Next time, circulate the budget numbers the day before. I should also ask Rosalind how she wants to handle the 44 percent gross margin target, because tooling spend will hurt it in Q2.

## Appendix: parking-lot items from the flip chart

These did not get airtime but someone wrote them down, so I am keeping them here so they are not lost.

- Warehouse labeling: Luis wants serial numbers printed on the inside of the enclosure lid as well as the outside, because outer labels fade after two winters in the field. Cost is a few cents a unit.
- Documentation: Ines is not here yet, but Marcus wants a single page that maps every LED blink pattern to a cause. The page exists in three slightly different versions and none is right.
- Test fleet: Hana would like to retire the six oldest Pika-1 units from the Wasatch group, since their radios are a generation behind and they muddy the soak data. Decision deferred.
- Sales enablement: Rosalind asked whether we should publish a public accuracy white paper. Marcus likes the idea; Joel said engineering has no time before June.
- Internal tooling: Priya mentioned a tool that would show per-customer data freshness. Parked until after the ingest rewrite.
- Offsite logistics: lunch was catered from the sandwich place across the road; 14 orders, $286 total. Dev will not reimburse the one person who ordered two.

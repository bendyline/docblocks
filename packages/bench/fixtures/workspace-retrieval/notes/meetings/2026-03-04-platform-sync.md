# Platform sync, March 4 2026

Attendees: Joel M (eng manager), Priya N (backend), Hana T (firmware), Luis R (QA), Marcus E (support lead)

## Agenda
1. Firmware 4.2 status
2. Cairn ingest backlog after last week's alert storm
3. Beta cohort sizing

## Firmware 4.2
Hana walked through the soak results. The Pika-3 stations in the Wasatch test group are dropping roughly one uplink in forty after the radio driver change. Luis reproduced it on the bench with the duty-cycle limiter set to 1 percent.

Decision: Firmware 4.2 ships April 14, not March 31, because the LoRa duty-cycle regression (TKT-2231) needs two more weeks of field soak.

Marcus asked whether support should warn the three customers who were promised a March date. Joel will send those notes himself.

## Cairn ingest backlog
Priya reports the backlog cleared on Monday night. Peak depth was 1.4 million messages on queue `ingest-raw-02`. No data was lost, but dashboards lagged by about 50 minutes. She wants to revisit retry behavior but not this week.

## Beta cohort
Currently 40 devices. Luis thinks 40 is too few to see rare radio faults. Parked until next week.

## Action items
- Hana: publish 4.2-rc2 build to the beta channel by Friday March 6
- Luis: write a repeatable duty-cycle test, owner of TKT-2231 verification
- Joel: email the three customers about the new April date
- Priya: draft a proposal on retry limits for the March 11 sync

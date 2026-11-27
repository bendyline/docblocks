---
tags: [hiring, embedded, scorecard]
---
# Hiring loop: Embedded engineer, candidate Omar B

Role: Embedded Engineer II, reporting to Hana T. Loop held June 3 2026, virtual. Same five sessions as the previous candidate.

## Background
Five years at a wearable startup. Strong C++ on nRF52 with FreeRTOS. Wrote BLE stacks glue. Has done LoRaWAN work for a smart-agriculture side project. Not much experience with long-lived outdoor devices or cold-weather hardware.

## Sessions
1. Phone screen with Hana: very good on LoRa, duty cycle, and spreading factors. Vague about flash wear leveling.
2. Code review exercise with Luis: found the race condition in 6 minutes but missed the buffer length bug entirely, even with two hints.
3. Systems design with Priya: store-and-forward design was clean and he raised clock drift unprompted. Overengineered the compression step.
4. Hardware debugging with Hana: struggled with the logic analyzer capture; guessed at a pull-up resistor issue before reading the trace. Got there eventually after 30 minutes.
5. Values chat with Joel: enthusiastic, a bit talkative, curious about the product. Asked nothing about on-call.

## Scorecard (1 to 4)

| Area | Hana | Luis | Priya | Joel |
| --- | --- | --- | --- | --- |
| Embedded C | 3 | 2 | n/a | n/a |
| Debugging | 2 | 3 | 3 | n/a |
| Systems thinking | 3 | n/a | 4 | n/a |
| Communication | 4 | 3 | 3 | 3 |
| Collaboration | 4 | 3 | 4 | 4 |

## Debrief
Hana: no hire for this level, would consider for a junior role; debugging method was the concern. Luis: lean no. Priya: lean yes on design strength. Joel: lean yes on energy and fit.

## Decision
No offer for Embedded II. Hana will ask him whether he would consider a one-level-lower role on the test team. Declined to move forward on June 9; he said he would think about the junior role and did not follow up.

## Compare with Dana
Dana scored higher on debugging and fundamentals; Omar was better on LoRa and design. For this team the debugging gap matters more because field failures are hard to reproduce.

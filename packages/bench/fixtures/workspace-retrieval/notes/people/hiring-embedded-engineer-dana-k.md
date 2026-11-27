# Hiring loop: Embedded engineer, candidate Dana K

Role: Embedded Engineer II, reporting to Hana T. Loop held June 2 2026, virtual, five sessions. Recruiter: Dev P handled scheduling.

## Background
Eight years at a motor controller company, mostly C on Cortex-M4, some Zephyr. Has shipped OTA updates to a fleet of roughly 30,000 devices. No LoRa experience.

## Sessions
1. Phone screen with Hana: strong on interrupt handling and power states; weak when asked about radio duty cycle regulations.
2. Code review exercise with Luis: found the planted race condition in the sample sampler task within 12 minutes, and the buffer length bug after a hint.
3. Systems design with Priya: designed a store-and-forward buffer for a station that loses uplink for 48 hours. Good instincts about flash wear; did not think about clock drift on the device until prompted.
4. Hardware debugging with Hana: given a logic analyzer capture of a failing I2C read. Solved correctly, explained the clock stretching issue clearly.
5. Values chat with Joel: thoughtful, direct, asked good questions about on-call.

## Scorecard (1 to 4)

| Area | Hana | Luis | Priya | Joel |
| --- | --- | --- | --- | --- |
| Embedded C | 4 | 3 | n/a | n/a |
| Debugging | 4 | 3 | 3 | n/a |
| Systems thinking | 3 | n/a | 3 | n/a |
| Communication | 3 | 3 | 4 | 4 |
| Collaboration | 3 | 4 | 3 | 4 |

## Debrief
Hana: strong yes, would hire; the radio gap is trainable. Luis: lean yes. Priya: lean yes, wants to see her take on drift. Joel: yes.

## Decision
Offer extended June 8 at $142,000 base. Dana countered at $150,000 on June 10. We settled at $146,000 plus a signing bonus of $5,000. She accepted on June 12 and starts July 20.

## Notes
She asked about winter fieldwork, which is a plus. Her references from two former managers were glowing about her calm during field failures.

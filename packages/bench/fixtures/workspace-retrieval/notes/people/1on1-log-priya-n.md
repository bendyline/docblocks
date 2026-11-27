# 1:1 log: Priya N

Weekly, Thursdays at 10:00, unless noted. Priya is a senior backend engineer, joined in 2023, leads the Cairn work. Newest entries at the bottom.

## 2026-01-15
She is tired after the storm weekend. She was on call and handled the queue backup mostly alone for 14 hours. I told her to take Monday off and she did. Wants clearer escalation rules so that a second person is paged if the first has not acknowledged in 10 minutes.

Career: she asked what staff engineer would look like here. I said we do not have the ladder written yet; I will draft it by the end of Q1.

## 2026-01-29
Talked about the hosted queue limits. She has a spike showing JetStream could do replay. Excited. I asked her to write it up as a decision record rather than a slide.

She mentioned she is annoyed that the API cleanup keeps stealing her time. Agreed to hand the API error-text work to a contractor if one gets approved.

## 2026-02-12
Quick one. Her mother is visiting next week so she will be offline Wednesday and Thursday. Fine.

Feedback I gave: her design docs are strong but she hides the recommendation at the bottom. Put the decision in the first paragraph.

## 2026-02-26
Priya wants to present at an infrastructure meetup in the fall. I said yes and that the company will cover it. Topic: replay-first ingest design.

She is worried that Tomasz and she disagree about alert thresholds and that it will become personal. I said disagreement is healthy and offered to sit in on their next proposal review.

## 2026-03-19
Retry ceiling and dead-letter queue shipped a day early. I told her I noticed. She said the dead-letter queue replay tool is still a rough script and she is embarrassed by it. Asked her to timebox cleanup to two days.

## 2026-04-09
Compensation conversation. She is paid $168,000 and has asked about a raise. Leadership is doing adjustments in July; I told her I will advocate for her to land at $178,000 and that I cannot promise the number. She took that well.

She asked for more say in who we hire. I invited her to the embedded engineer interview loops as a systems-design interviewer.

## 2026-05-14
She finished the ADR for the message broker and it got accepted. I told her the first paragraph worked. She is nervous about operating JetStream in production since nobody has done it. We agreed on a game day in August.

Personal: she is training for a half marathon in September, so she is shifting her workday earlier. Meetings after 4 pm are hard for her. I will keep that in mind for scheduling.

## 2026-06-04
Burnout check. She is doing too much: Cairn, interviews, API cleanup, and mentoring Ines on tooling. We cut API work entirely and I will take the Marcus escalations myself for a few weeks.

She also said she does not want to be a manager, ever, and wants that to be understood. Noted.

## 2026-07-16
The July adjustment came through: $176,500, not $178,000. I owned the gap and explained that the band was capped. She was disappointed but not angry. We agreed to revisit in January and I wrote that down in the review calendar.

She asked to attend the infrastructure meetup in October; the CFP accepted her talk. Travel booked through Dev P.

## 2026-08-13
Game day went better than expected. Killing two nodes produced a clean recovery in under 9 minutes. She found a bug in the consumer reconnect logic and fixed it the same afternoon.

Concern: Tomasz is leaving for two weeks in September and she would be the only person who knows the bus. We will run a cross-training session with Hana before then.

## 2026-09-10
Phase 3 wave 1 went well. She is sleeping badly during cutover weeks. I asked her to hand the on-call pager to Tomasz for wave 2, and she agreed reluctantly.

She raised an idea: a small internal tool that shows each customer's data freshness. Marcus would love it. I told her to write a one-pager and I would carry it to planning.

## 2026-10-08
Planning for next year. She wants to spend half her time on reliability and half on new product pipeline work, and not carry any support escalations. Reasonable. I will propose a staff engineer track in the January review cycle; I still owe her the ladder document, which I promised in January. I should apologize for that.

## Running threads

- Staff engineer ladder document: promised Q1 2026, not done. Overdue.
- Pager policy: second page after 10 minutes without acknowledgment, implemented in March.
- Compensation: revisit January 2027.
- Meetup talk: October, replay-first ingest design.
- Preference: no meetings after 4 pm during half-marathon training.

## Things she does well

She writes the best incident timelines on the team and she is generous in code review. She tends to take on work quietly until it breaks her schedule, so the pattern to watch for is silence, not complaints. When she goes quiet in standup, ask about her load directly.

## Things to watch

- She avoids asking for help from Tomasz when they disagree, which slows decisions.
- She under-documents operational steps for things she thinks are obvious. Ask for a runbook page at the end of every project.
- Her estimates for the cutover phases are optimistic by about 30 percent based on phase 0 and phase 1. Pad them.

## Questions for next time

1. Does she want a different kind of mentee than Ines, someone more junior to the backend?
2. Would she be willing to be the interviewer-in-training lead for new engineers' first on-call shadow?
3. What does she need from me to feel less alone on the Cairn work?

## Appendix: topics to bring up at the next review cycle

- Whether her title should change from Senior Backend Engineer to Staff Engineer at the January 2027 cycle, and what evidence supports it: the replay-first design, the August game day, the March retry ceiling work, and her mentoring of Ines on tooling.
- A written summary of her operational contributions, since much of her work is invisible when it goes well. Cutover wave logs and the incident timelines are the best artifacts.
- Her request to reduce meeting load. A count from the calendar shows she spent about 11 hours a week in meetings in September, up from 6 in March. Candidates to drop: the Tuesday leadership digest and the duplicate planning meeting.
- A conversation about whether she wants to be on the interview panel for the app engineer role in Q3 or Q4.

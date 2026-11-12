# Quillfeather Support Engineering: Your First Month

Welcome to the Support Engineering team at Quillfeather Software. Our product, Ledgerline, is a cloud invoicing and payments service used by about 41,000 small businesses. As a support engineer you are often the first technical person a customer talks to. This handbook explains what your first month looks like, the tools you will use, how we prioritise tickets and when to escalate. Keep it handy: your 30-day review is based on it.

## Your first four weeks

Your first day is a Monday. Arrive by 9:30 a.m. on the fourth floor of the Harbourline Building for orientation with Dalia Fennimore, the support team lead. You will receive your laptop, a hardware security key and an onboarding buddy, an experienced engineer who answers your questions for the whole month.

- **Week 1: Learn and shadow.** Complete the six Ledgerline product modules in the training portal and shadow your buddy on at least 20 tickets. You do not reply to customers this week.
- **Week 2: Supervised replies.** You take P4 tickets (general questions) yourself, and your buddy reviews every reply before it is sent.
- **Week 3: Independent work.** You handle P4 and P3 tickets on your own; your buddy spot-checks five of your tickets each day.
- **Week 4: On-call shadowing.** You shadow the on-call engineer for two evening shifts and attend the weekly incident review on Thursday at 2:00 p.m.

At the end of week 4 you take the Ledgerline certification quiz. The pass mark is 80 percent, and you may retake it once, after 48 hours. Your 30-day review with Dalia follows the quiz.

## Tools you will use

- **Helmsman** is our ticketing system. Every customer conversation, whether it arrives by email, chat or phone, becomes a Helmsman ticket. Never handle a customer request outside Helmsman, because untracked work cannot be audited or handed over.
- **Compass** is the internal wiki that holds our runbooks. Search Compass for a runbook before you escalate; there are currently about 230 of them.
- **Tallyboard** shows live team metrics, including queue size, first-response times and customer satisfaction. Our satisfaction target is 92 percent.
- **Beacon** is the public status page. Only the incident commander may post to Beacon.
- **Parley** is our chat tool. Use #support-floor for everyday questions and #sev-room only during an active P1 or P2 incident.

Your admin access to customer accounts is read-only for your first 60 days. Write access is granted after you pass the certification quiz and your team lead signs off.

## Ticket priorities and response targets

Every ticket gets a priority when it is triaged, and the priority sets the first-response target:

| Priority | Meaning                                                                  | First response   |
| -------- | ------------------------------------------------------------------------ | ---------------- |
| P1       | Ledgerline is down, or payments are failing for all customers            | 15 minutes, 24/7 |
| P2       | A major feature is broken for many customers, or any report of data loss | 1 hour           |
| P3       | A feature is broken for one customer and a workaround exists             | 8 business hours |
| P4       | Questions and how-to requests                                            | 2 business days  |

Business hours are 7:00 a.m. to 7:00 p.m., Monday to Friday. Support runs three shifts: 7:00 a.m. to 3:30 p.m., 11:00 a.m. to 7:30 p.m., and 3:00 p.m. to 11:30 p.m. New engineers work the middle shift for their whole first month. Weekend rotation, one weekend in four, starts in your third month.

## Escalation rules

Escalating early is never a mistake; escalating late often is. Follow these rules:

1. **P1 incidents.** Press the "Page IC" button in Helmsman immediately. Do not try to diagnose a P1 alone first. The incident commander takes over customer communication, and you stay on the ticket to gather reports.
2. **Data loss.** Any report of missing or corrupted invoices is at least a P2, even if only one customer is affected.
3. **Stuck tickets.** If you have made no progress on a P2 for 45 minutes, or on a P3 for one business day, escalate to Tier 2. The Tier 2 lead is Marcus Oyelaran.
4. **Refunds and credits.** You may issue credits of up to $500 on your own. Anything above $500 needs approval from a team lead.
5. **Security.** Possible security issues, such as a customer reporting a login they don't recognise, go straight to the security team through the "Security" queue in Helmsman, never through Parley.

Never share one customer's data with another customer, even if they say they work together. Ask the account owner to grant access instead.

## Getting help

Nobody expects you to know everything in your first month. Ask your buddy first, then post in #support-floor. Dalia holds open office hours every Wednesday from 4:00 to 5:00 p.m. If you are ever unsure whether something is a P1, treat it as one: Marcus likes to say he would rather be paged ten times for nothing than miss one real outage.

# Security review, April 22 2026

Attendees: Tomasz W, Joel M, Ingrid S (outside consultant, two-day engagement), Priya N

Scope: device identity, OTA signing, and the customer-facing API. This was a review of design documents plus a short hands-on session; it was not a full penetration test.

## Findings
1. Device client certificates are issued with a 3-year lifetime and no rotation path. The oldest fleet certificates, from the Pika-1 generation, expire on 2027-01-09.
2. OTA firmware images are signed with a key that lives on a build server disk. Ingrid rated this high severity.
3. The customer API returns different error text for "unknown station" and "station belongs to another account", which allows enumeration of station IDs.
4. Dashboard session cookies are missing the `SameSite` attribute.

## Decisions
- The OTA signing key moves to a hardware security module by Aug 15 2026. Budget: $4,200 for the module plus about two weeks of Tomasz's time.
- Certificate rotation will be built into firmware 4.3, not 4.2, so the April 14 date is unaffected.
- Findings 3 and 4 are small and go into the next API release, 2.19.

## Action items
- Tomasz: order the HSM and write the key ceremony procedure
- Priya: normalize API error responses (TKT-2402) and add the cookie attribute (TKT-2403)
- Joel: schedule a follow-up with Ingrid for the week of September 7 to check progress

# Atlas Migration: Status Update for Week 14

Hi everyone,

Here is where the Atlas migration stands this week, what is still in progress, and what we need from you.

## What we finished

- The billing service now runs on the new cluster. It has been stable for five days and error rates are back to normal.
- We moved the reporting jobs, although two of them still needs manual restarts after the nightly backup.
- Ravi finished the the load tests for the search service. The new cluster handled twice our peak traffic without slowing down.

## What is in progress

The search service is the largest remaining piece. At this point in time, due to the fact that the index is very large, it is going to take a significant amount of time for us to be able to copy it over to the new cluster.

We are also moving the notification queue, which sends order and shipping emails. It is smaller than the search index, so we expect it to move in a single evening.

## Schedule

We are still on track to finish the migration by Friday, May 16. The billing and reporting work came in under budget, so the remaining hours should cover the search service.

## Risks

The old cluster's support contract ends on May 31. If the search index copy fails, we will not have time to try again before then. It will be decided later who handles the rollback.

## Next steps

- Kim will finish the alert pipeline move by Wednesday.
- The cutover is planned for Monday, May 19, after the weekend freeze.
- We recieve the new hardware quote on Thursday.

Finally, we need a decision from the leadership team by Tuesday on whether to pay for a two-week extension of the old support contract. Without it, a failed index copy would leave us with no fallback.

Thanks,
Dana

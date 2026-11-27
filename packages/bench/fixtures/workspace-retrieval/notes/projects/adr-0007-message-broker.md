---
tags: [adr, architecture, cairn]
---
# ADR 0007: Message broker for Cairn

Status: accepted, 2026-05-19. Deciders: Priya N, Tomasz W, Joel M.

## Context
Cairn's current queue is a hosted queue service with a 256 KB message limit and no replay. We need replay for backfills after outages, and the monthly bill for the hosted service passed $3,100.

## Options
1. Stay on the hosted queue and bolt on an archive bucket.
2. Self-host Kafka. Rejected: too much operational weight for a three-person platform team.
3. Self-host NATS JetStream on three nodes (`bus-01`, `bus-02`, `bus-03`).

## Decision
We adopt NATS JetStream. Streams are replicated three ways with 72 hours retention for raw telemetry.

## Consequences
- We own upgrades and certificates for the cluster.
- Replay of a 6-hour window takes about 11 minutes in staging.
- Estimated run cost is $780 a month.
- Migration plan lives in the Cairn rewrite plan.

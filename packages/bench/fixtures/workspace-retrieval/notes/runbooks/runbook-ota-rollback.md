# Runbook: roll back an OTA firmware release

Use when a firmware release causes field regressions and the release owner has approved rollback.

## Preconditions
- Release owner (Hana T for firmware) confirms in the incident channel.
- Know the target version, for example `4.1.9`.

## Steps
1. Halt the rollout: `otactl campaign pause --id <campaign-id>`.
2. Check how many stations have already installed: `otactl campaign status --id <campaign-id>`.
3. Create a rollback campaign pointed at the previous version: `otactl campaign create --from-version 4.2.0 --to-version 4.1.9 --cohort all-updated`.
4. Stations keep the old image in the secondary slot for 14 days. Rollback of those is a slot swap and takes about 4 minutes per device on a good link. After 14 days the image must be downloaded again, about 38 minutes on LoRa fallback.
5. Watch the swap rate: `otactl campaign status --watch`. Healthy is above 60 percent within 24 hours.
6. Post in the status page draft and notify Marcus.

## Do not
Do not rollback devices below firmware 4.0, because the bootloader changed and will brick the radio. The tool refuses but verify anyway.

## After
Write a short incident note, link the campaign id, and add a TKT to explain what was missed in beta.

# Product roadmap

Phases 1–4 form the locally verified operational spine. Their detailed capabilities and limits are recorded in [PRODUCT_FEATURE_MAP.md](PRODUCT_FEATURE_MAP.md). This sequence describes future scope, not completed functionality or authorization to provision services.

| Phase | Scope                                                                                | Status                                                                                                 |
| ----- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| 5     | Assisted company onboarding, team administration and reusable business configuration | IMPLEMENTED / WORKING locally; see handoff for owner-device/publication limits                         |
| 6A–6B | Company integration management and reliable form/signed/Gmail intake                 | IMPLEMENTED / PARTIAL acceptance; browser pending, older session suite unfinished; live Gmail DEFERRED |
| 6C    | Governed external sending, calendar and CRM synchronization                          | NOT BUILT; separate from Phase 6A–6B                                                                   |
| 7     | Knowledge, AI assistance and management visibility                                   | NOT STARTED; paid product AI remains disabled                                                          |
| 8     | Customer portal and delivery                                                         | NOT STARTED                                                                                            |
| 9     | Subscriptions and platform operations                                                | NOT STARTED                                                                                            |
| 10    | Production hosting and hardening                                                     | DEFERRED                                                                                               |
| 11    | Founding-customer validation and v1                                                  | NOT STARTED                                                                                            |

Current hosting and deployment-trigger settings are preserved. Phase 6A–6B includes the normal local ingestion runner, source receipts, human review and existing proposal handoff; it does not authorize real Gmail access or external writes. See [Phase 6 handoff](PHASE6_HANDOFF.md) for distinct implementation, verification and publication states. Later CI/CD or hosting decisions require corresponding owner-authorized scope. Source publication requires verified absence of automatic deployment linkage and the reviewed export process; deployment is a separate track.

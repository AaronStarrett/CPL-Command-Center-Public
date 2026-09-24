# Local Phase 5 testing

**Both fictional company workflows, configuration history, local build and exact normal restart persistence are PASS.** The final post-restart browser readback is **PASS** after the owner reopened localhost. Source publication is **BLOCKED / NOT PUBLISHED**; hosting remains **DEFERRED**.

## Open the local application

In the existing canonical checkout, double-click `RUN-CPL-COMMAND-CENTER.cmd`, then open <http://127.0.0.1:3400/workspace>. Use `STOP-CPL-COMMAND-CENTER.cmd` and `RESTART-CPL-COMMAND-CENTER.cmd` for normal shutdown/reopen. The normal Stop/Restart sequence preserved the complete two-company snapshot: 72 tenant tables, 416 rows, four approved PDFs and six photo files. No routine dependency install, setup command or manual worker drain is needed.

The screen identifies this as **DEVELOPMENT**. Synthetic local identities do not establish real provider authentication or MFA. Keep Riverside and Cedar Grove intact. Open an existing Phase 5 record before considering creating another.

## Choose the identity and company

Use **Development identity**, then **Enter development workspace** when signed out or **Switch development identity** when signed in. Use **Organization** to choose an authorized company.

| Identity                      | Company                                         | Intended local role                |
| ----------------------------- | ----------------------------------------------- | ---------------------------------- |
| Synthetic company owner Alpha | PHASE 5 - Alder Inspection Services · Synthetic | Owner                              |
| Synthetic company owner Beta  | PHASE 5 - Harbor Design Studio · Synthetic      | Owner                              |
| Synthetic manager             | Alder                                           | Manager                            |
| Synthetic manager             | Harbor                                          | Member                             |
| Synthetic platform operator   | No company membership                           | Assisted company provisioning only |

The two companies were created through the platform screen with separate initial owners. Do not create replacements. The platform operator has no automatic access to their business records. Alpha and Beta configure their own companies.

For the shared manager, switch between Alder and Harbor and verify the role beside the identity. A manager can review operational work; a member can draft supported work but cannot inherit the manager's approval or company-administration controls. Company membership does not grant platform provisioning authority.

Changing company or identity with unfinished entries opens **Keep your work**. **Keep editing** retains the current form; deliberately discarding continues the switch. When a refresh detects changed membership/permissions, entries remain visible but submission is blocked. Use **Review current access** deliberately before continuing; do not submit a retained old-company form into the newly selected company.

## Invite and manage the team

As the company owner, open **Company settings → Team & invitations**.

1. **Members** shows current company roles/status. Select the intended member, choose an allowed role/status and enter the required reason before saving. The last active owner is protected. Historical authorship remains recorded when access changes.
2. In **Invitations**, select a fixed verified development recipient and an allowed role, then **Create local handoff invitation**. The handoff is labeled **NOT SENT**. Copy it only for the intended synthetic recipient; it is a one-use credential, not ordinary audit content.
3. Switch to that recipient identity, choose **Accept an invitation**, paste the local handoff and choose **Accept invitation as this identity**. Select the newly available company afterward if no company is selected.
4. Revoke or reissue an eligible invitation with a reason through the invitation row. Old, revoked, expired, superseded or already consumed handoffs cannot grant new access.

Saving one invitation form preserves unfinished entries in other forms. The screen may defer list refresh until those entries are saved or explicitly discarded. Search, status filters and page controls apply to this company's authorized records. This phase sends no invitation email.

## Configure the company

Open **Company settings** as Alpha or Beta. The setup summary reads saved configuration; it is not a checklist of unconnected switches. Basic setup, configured modules and operational readiness are distinct.

| Section                                         | Normal action and effect                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Setup & profile**                             | Save display/legal name, contact details, address and timezone with **Save company profile**. Wait for the persisted version and saved feedback. New operational defaults may use the timezone; existing scheduled instants do not move.                                                                |
| **Service catalog**                             | **New catalog item → Save catalog item revision**. Use the supported currency and an explicit price, including zero when intended. Saved items have a stable identity and fixed workflow key. Rename/price edits create current revisions; archive/reactivate with a reason rather than delete history. |
| **Intake rules**                                | Configure supported required fields and text/boolean/choice custom questions. Save the policy version. Stable field IDs and recorded answers remain; the core business/security requirements cannot be disabled.                                                                                        |
| **Documents & readiness**                       | Use **proposal branding**, **proposal templates**, **field templates**, **report branding**, **report templates** and **readiness**. These are the existing versioned editors. Proposal and report branding are separate; the CPL application logo remains unchanged.                                   |
| **Configure workflow recipes in Action Center** | Open the existing **Recipes** editor. Deliberately choose the exact service, supported assignee and template version; enable only intended handoffs. Disabled/manual workflows do not secretly run.                                                                                                     |
| **Directory**                                   | Choose customer, contact or site; search, open a record, edit a current revision, or archive/reactivate with a reason. Contact/site links must belong to the selected company's customer.                                                                                                               |
| **Activity**                                    | Filter by supported action/date/actor, page through authorized events, and use **Open related record** for the exact permitted setting or record. Historical events are not editable.                                                                                                                   |

Do not navigate away from a pending save. Saved feedback is followed by the persisted DTO/version. A stale save retains entries and explains reloading/reviewing the newer version. Editing an archive reason does not silently discard a record form, and a delayed detail response cannot replace an editable new form.

### Two deliberately different approved workflow examples

| Setting                       | Alder — entered through the UI                                               | Harbor — entered through the UI                                                                                                      |
| ----------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Service/workflow key          | `ALDER-ASSESS`                                                               | `HARBOR-DESIGN`                                                                                                                      |
| Approved agreement/currency   | USD 650.00                                                                   | CAD 1,200.00                                                                                                                         |
| Company timezone              | America/New_York                                                             | America/Los_Angeles                                                                                                                  |
| Saved document accents        | Proposal `#155E75`; report `#163B4F`                                         | Proposal `#155E75`; report `#163B4F`                                                                                                 |
| Additional intake requirement | Site address, email and access-confirmation answer                           | Required **Design brief** choice: Concept study / Layout review                                                                      |
| Readiness policy              | Award, completed work, approved report, purchase order and issue disposition | Award, completed work, approved report and issue disposition; manual send and purchase order intentionally not required by policy v1 |

A different currency is an explicitly selected price, not a conversion. New templates pin currency; a legacy unpinned template may require deliberate currency confirmation. New catalog/template values must not relabel an old approved price or awarded amount.

Harbor's normal UI flow now reached configured readiness: the saved Design brief was **Concept study**, proposal **Q-2026-9E9B989F9BFA v2** retained **CAD 1,200.00**, project **PRJ-2026-7B9042CF99DF** and its Pacific **16:00–16:30** visit were completed, report **RPT-2026-4405ECDD496D v2** was approved, and package **DEL-DDB9179696E7 v1** is **ready / NOT SENT**. Harbor policy v1 reports ready without a purchase order or recorded send. Alder also completed its own configured workflow; its original lead now requires review under the revised intake policy, as described below. All four approved proposal/report PDFs were visually inspected across their eight pages. Exact database/file restart persistence subsequently passed; native save dialogs remain NOT RUN.

### Compare current configuration with preserved history

Alder's current catalog revision 2 has a revised name and **USD 675.00** price. Branding revision 2 has the revised business identity; site revision 2 has the revised **202** address; report template revision 2 is saved separately from version 1. A new proposal-template copy changes payment terms from **net 30** to **net 21**, while general terms remain unchanged. Intake policy version 2 adds the required text answer **Access review reference**.

The comparison after those changes passed exactly across **27 tables / 76 preserved workflow rows**. The original approved agreement remains **USD 650.00**, its captured site address remains **200**, and its saved sources retain intake policy version 1 and report template version 1. Current settings do not rewrite approved PDFs, awarded amounts or historical source snapshots.

The original Alder lead is **not currently eligible for another proposal**: the new policy requires another human review and **Create proposal** is disabled. Keep that historical lead unchanged for comparison. The separate **PHASE 5 FICTIONAL - Alder revised configuration check v2** lead now has saved proposal **Q-2026-7D24DAB8226E v1 — DRAFT**, with **USD 675.00**, the current **202** address, catalog revision 2, intake policy version 2 and the required text answer. The loaded customer preview showed the revised business identity, price and address. It has **no approval, PDF or award**.

Enabled recipe version 2 explicitly disables automatic draft preparation for future events while retaining the manager action **Review the new synthetic Alder catalog proposal**. The previous execution remains tied to recipe version 1. The task-only recipe does not create the follow-up draft automatically; after current intake requirements and review are satisfied, an authorized person uses **Create proposal** deliberately.

## Run each company's normal workflow

Use Alpha/Alder and Beta/Harbor separately. For Alder, reopen the existing Maple Annex example; Harbor's saved example is **PHASE 5 FICTIONAL - Harbor studio brief and documentation**. All evidence must remain clearly fictional.

1. **Leads**: open/create the intended lead, select the saved customer/contact/site and catalog item, enter the request, assignee, next action and custom answers, then save. Review current readiness and any duplicate warning. Mark **Ready for proposal** only after the saved current policy is satisfied. A changed policy can require **Reload saved review** and another explicit review.
2. Open the ordinary worker's linked draft when an enabled recipe created one. Otherwise use **Create proposal** once. Review captured lead/catalog/template values and customer preview. Save a version, submit it for review and approve that version as an authorized reviewer. Generate/download its approved PDF; generation is not sending or customer acceptance.
3. Record the fictional award with the approved amount/currency and a clear synthetic reference. Open the linked project if a configured handoff prepared it; otherwise deliberately create the project. The project retains its awarded version and agreed amount.
4. In the project, use **Operations** to save responsibility/next action and a valid visit. Planned times use the displayed visit timezone; verify the committed values before saving. Open **Field work**, select the visit and attach its saved checklist version. Complete required entries, upload an explicitly synthetic image, wait for **ready**, and select that photo in the required checklist entry. Merely uploading does not satisfy photo selection.
5. Save human-entered observations/captions and explicitly mark only appropriate evidence eligible for reports. Record actual start/finish and complete the visit after required tasks/checklist/upload gaps are resolved. Use retry/recovery for interrupted uploads; do not delete old attempts to manufacture readiness.
6. In **Reports**, open the recipe-prepared draft or create one from the company's report template. Select the intended completed visit and eligible evidence. **Save report version**, review the customer preview, **Submit saved report for review**, then **Approve & generate final PDF**. If sources changed, deliberately **Refresh sources** using the intended selection. Approved historical PDF bytes remain immutable.
7. In **Delivery & closeout**, prepare a package with the exact approved report version and fictional recipient/message. Save, review the recipient and attachments, confirm the review checkbox, then **Mark saved package ready**. **Record package export** and the saved manifest/message/PDF downloads do not send anything.
8. Open readiness, select the supporting approved report and record the actual supporting facts required by that company's policy. Add an operational purchase-order supplement only when required; it does not rewrite the award. Resolve/accept issues with human reasons. A billing handoff is an internal export; invoice issuance and payment remain **not tracked**.

Record fictional manual delivery only when explicitly required by the acceptance scenario, using the stated time, channel, recipient, reference and note. **Use current time** is an operator choice, not evidence that sending occurred. The history distinguishes stated send time from the recorded audit time and shows who recorded it. Do not mark real delivery or acknowledgement for an export/download.

## Reopen and compare saved work

Save all forms before a normal launcher restart. Reopen both companies as their owners, then the shared manager. Verify the same profiles, memberships, invitation states, catalog/policy/template versions and linked workflow records; verify exact approved artifacts and delivery versions. Do not require a manual queue-drain step.

Directory/catalog/branding changes affect current data or explicitly refreshed drafts. Open historical proposal/project/report/delivery snapshots separately to confirm that approved PDFs, awards, recorded recipients and source evidence remain unchanged. The final comparison preserved all 666 original protected rows and all 52 original evidence files, including Riverside/Cedar approved artifacts.

Current evidence supports the two-company provisioning/invitation and unsaved-switch checkpoint, connected configuration, focused authorization/UI checks and both ordinary company workflows through configured readiness. The normal directory flow passed create, edit, archive, reactivate, empty search and one-result search. Activity showed 46 events across two pages (25 + 21), four filtered events and a correct related-record link. The settled 390-pixel narrow layout passed. All four PDFs/eight pages were visually inspected, and the configuration-change comparison preserved 27 tables / 76 workflow rows exactly. The separate follow-up draft is saved with revised configuration; normal restart/preservation readback and the local production-mode build passed. The extra unsaved-change dialog after saved workflow navigation was corrected: component regressions and normal browser retakes passed for the lead-to-saved-draft-to-settings handoff and the subsequent Beta/Harbor identity switch, without a false prompt. Real unsaved edits remain protected by **Keep editing**. Automated results are indexed separately in the implementation evidence; component tests are not browser or real PostgreSQL acceptance.

Native save-dialog completion, a physical phone/camera, unsupported filesystem junctions, real identity-provider/email acceptance and deployed-runtime acceptance retain separate **NOT RUN / DEFERRED** limits unless individually verified. No cloud resource, external message, accounting call or paid product AI is required by these local steps. Source publication remains **BLOCKED** and is distinct from deployment.

Post-restart database/file persistence and final browser readback are PASS. After the owner manually reopened localhost in a fresh tab, both owner workspaces reopened with their saved setup and linked work; the shared user retained manager access in Alder and member access in Harbor. The application remains READY with the Alder owner workspace open. The earlier retained-error-page restriction and its resolution are recorded separately in `post-restart-browser-boundary.json` and `post-restart-browser-complete.json`; no browser-policy workaround was used.

# Local Phase 3 testing

Double-click `RUN-CPL-COMMAND-CENTER.cmd` in the existing project checkout. It opens `http://127.0.0.1:3400/workspace`. The existing STOP and RESTART launchers remain available. Choose **Enter development workspace**, then **CPL Development · Synthetic**.

## 3A: project execution and scheduling

Open **Proposals → Projects → PHASE 3 DEMO - Riverside site assessment**. Its editable operational name is **PHASE 3 DEMO - Riverside Learning Center**.

- **Operations:** owner, team, next action, operational instructions and private notes; use **Save project operations**.
- **Visits:** initial building envelope assessment and follow-up general service review, both fictional. Open a visit to change its dates, responsibility or tasks. **New visit** creates another independent appointment. Dates use the displayed visit timezone, initially America/Indiana/Indianapolis.
- **Agenda:** select a date range to see company visits. Overlapping appointments for the same responsible member are rejected with conflict details.
- **Awarded agreement:** the exact original proposal version and source lead remain linked and unchanged.
- **Activity history:** saved operations, rescheduling and cancellation reasons remain visible. The optional browser-test visit is cancelled; the project remains active.

Save before leaving a form. Unsaved navigation offers **Keep editing** or **Discard changes**. Failed or stale saves retain the form; the server rejects overwriting a newer revision. Required tasks and actual work timestamps must be recorded before completing a visit. Cancelling a visit does not cancel the project.

3A is **WORKING locally**: real PostgreSQL, API, browser, keyboard confirmation and application restart readback passed. Phase 1/2 focused regressions passed. The broader product and production hosting are not accepted by this result.

## 3B: field records and photos

Open the same project, then **Field work** and choose a visit. The initial building-envelope visit is completed and read only. The follow-up general-service visit has an incomplete draft for further testing.

- **Checklist:** save partial answers without pretending unchecked items passed. Required missing information remains visible. Templates support text, number/unit, date, choice, checkbox and photo requirements; visits retain the exact selected template version.
- **Observations:** enter location, component, human-written context/follow-up and separate private notes. Report eligibility is an explicit choice.
- **Photos:** choose multiple JPEG/PNG files, then **Upload selected photos**. Each file shows transfer/processing status. Open a photo to set its caption, observation link, order, overview flag and eligibility. Add an arrow, circle/oval, rectangle or label and adjust its percentage coordinates. **Save photo changes** preserves a metadata revision; the original stays intact.
- **Review visit:** missing field requirements prevent completion through the server. Open visit progress to complete required tasks and record actual start/finish. Pending photo processing must finish or reach a recoverable failed state before completion. A required photo must be ready. Reopen completed fieldwork with an explicit reason before editing it.
- **Field history:** inspect saved checklist, observation and photo events. Downloads retrieve private, authorized original files; no customer delivery occurs.

3B is **WORKING locally**. Real PostgreSQL, HTTP/API, browser upload/annotation, keyboard unsaved-navigation, narrow-viewport layout and restart checks passed. Seven originals and all fourteen derived images retained identical hashes after restart. These examples are synthetic illustrations, not actual property evidence.

## 3C: report assembly, review and PDF

Open the same project, then **Reports → PHASE 3 DEMO - Riverside field report** (`RPT-2026-59A5903D4DEF`). It contains two useful states: approved version 4 for the completed initial visit, and current draft version 6 including the unfinished follow-up visit.

- **Report builder:** choose visits, eligible observations and photos; edit customer-facing wording, summary, conclusion, section order and layouts. **Save report version** is explicit and preserves the previous version. Report wording never changes the original field record. Deselecting a photo does not delete its original.
- **Customer report preview:** inspect selected customer-facing content. Private notes, access information, commercial pricing and unrelated evidence are excluded. This content preview is not the final paginated PDF.
- **Source evidence & review:** missing requirements and changed sources prevent approval. **Review source refresh** explicitly incorporates changed field records into a new version. Complete the second visit before submitting the example's current draft.
- **Submit saved report for review:** a reviewer can request corrections with a reason or **Approve & generate final PDF**. Approval freezes the exact sources, annotations, template, branding, approver, timestamp and artifact hash. A rendering failure leaves a recoverable attempt instead of claiming approval.
- **Report versions & history:** choose **View report version 4** or **Download approved PDF version 4**. The retained approved PDF stays available even though the current version is a draft. Save downloads to the external SSD.
- **Open report revision:** supply a reason after approval to create an independent editable draft. It never replaces the approved PDF. An incomplete draft has no approved artifact of its own.
- **Report templates / Report company identity:** authorized company members can maintain versioned templates and company branding. The fictional example uses the current CPL logo. Existing report versions retain their captured configuration.

3C is **WORKING locally**. The browser exercised submit, request changes, correction, approval, history and a new two-visit draft. A fresh authenticated application API downloaded the real approved PDF and verified its recorded hash. All five PDF pages were rendered and visually inspected. The project, field files, six report versions and approved PDF read back identically after restarting the launcher. Physical device and native browser save-dialog checks are reported separately in the checkpoint notes; API download alone is not evidence of that dialog interaction.

## Limits

Physical phone/camera testing is **NOT RUN**. A secure, separately authenticated device preview is needed for that check; the local development identity is not exposed to a LAN or public tunnel. Full offline synchronization is outside this phase; unsaved changes remain in the open tab only. A failed save retains edits and requires retry; it is never shown as saved. JPEG/PNG are supported; other formats show an explicit error. Large files, image dimensions, processing concurrency and report output are bounded.

Approval is internal human review, not a client signature or professional certification. Downloading is not customer delivery. Customer portals, external sending, external calendars, AI diagnosis and invoice readiness are outside this phase. Hosting remains **DEFERRED**; paid AI usage is zero.

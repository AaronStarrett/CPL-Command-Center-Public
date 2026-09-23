# Local Phase 2 testing: proposal to project

Status: IMPLEMENTED and locally verified; ready for owner testing. Phase 1's accepted local intake and persistence results remain unchanged. Cloud hosting and Hyperdrive are DEFERRED; this guide does not deploy anything.

Use the already running [local workspace](http://127.0.0.1:3400/workspace), its **DEVELOPMENT** identity and fictional records. Keep the same company selected. This walkthrough does not stop or restart the app. The [opening guide](../OPEN-CPL-COMMAND-CENTER.md) remains the separate launcher reference.

## 1. Prepare a proposal

Start with a reviewed lead marked ready for proposal. In **Proposals & projects**, choose **+ New structured proposal** and select that lead. An existing manual draft can be explicitly upgraded while its original is retained. Creating another quote for the same lead requires the explicit additional-proposal choice.

Use company branding settings for the business name, contact details, accent color and optional PNG/JPEG logo. Save a reusable template with scope, terms, ordered custom sections and service items if useful. These settings belong to the selected company; customer documents use its identity, without a Command Center logo. Saved proposal versions retain their captured branding and template details.

## 2. Save the commercial details

Enter scope, deliverables, schedule, assumptions, exclusions, terms, payment terms and customer notes. Add line items with quantity, unit and price; review the configured discount, tax, currency and calculated total. Keep internal notes and operational access/constraints in their private fields.

Choose **Save proposal**. Typing is not a save: each successful save creates a retained version. Confirm that the unsaved warning clears and the displayed version changes. If another edit causes a conflict, refresh saved state and reconcile; do not assume your earlier screen replaced the newer record.

## 3. Review and approve an exact version

Choose **Submit for review**. With review permission, add a review note and either **Request revision** or **Approve version …**. For the revision path, save the corrected content and submit it again. **Open revision** requires a reason and removes current approval until a saved version is reviewed again. Earlier versions and review notes remain in history.

## 4. Inspect the customer document

Open **Customer preview & PDF**, inspect the saved customer content, then choose **Generate approved PDF** and **Download approved PDF v…** after approval. Check company/customer/site details, scope, all pages, line items, totals, reference and approved version. Confirm that internal notes, source evidence and operational instructions are absent.

The download is the recorded version's bytes. It is not an email, a signature, a customer portal or proof that anyone received or accepted it. Common Western European characters and smart punctuation are supported; unsupported characters produce a clear error rather than disappearing. Logos must be embedded PNG/JPEG, at most 128 KiB and 2048 pixels per side.

## 5. Record the outcome

Use separate fictional proposals to try lost or withdrawn outcomes and retain the required reason/note. For an approved proposal, explicitly record an award with its date, exact approved total/currency and any purchase-order/start details. Award recording represents your authorized entry; no external signature or payment provider is connected. The awarded proposal version is frozen.

## 6. Create and inspect the project

After award, choose **Preview project handoff**. Review the approved scope, customer/site, source lineage, dates and private operations notes. Check the confirmation box and choose **Create linked project**. This is a separate action from award recording and requires project permission and module access.

Open the linked project and compare its reference, approved proposal version, award and preserved source details. Repeating the same completed handoff must return that project, not create another. Project creation does not schedule work, assign field activity, send documents or create an invoice.

## Record the result

Note the company, proposal reference/version, PDF version and project reference, plus any failed step or unexpected behavior. Do not put credentials or real customer data in a report. Detailed automated/API/PDF evidence is tracked separately in the [feature map](PRODUCT_FEATURE_MAP.md); this checklist itself is not a PASS or owner-acceptance receipt.

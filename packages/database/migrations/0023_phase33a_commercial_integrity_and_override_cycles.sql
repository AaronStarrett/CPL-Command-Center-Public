ALTER TABLE proposals
  ADD COLUMN IF NOT EXISTS information_cycle_number INTEGER NOT NULL DEFAULT 0;

ALTER TABLE proposal_pricing_overrides
  ADD COLUMN IF NOT EXISTS target_version_number INTEGER NOT NULL DEFAULT 1;

ALTER TABLE proposal_pricing_overrides
  ADD COLUMN IF NOT EXISTS draft_cycle_number INTEGER NOT NULL DEFAULT 1;

UPDATE proposals
   SET information_cycle_number = 1
 WHERE information_cycle_number = 0
   AND (
     status = 'needs_information'
     OR id IN (
       SELECT proposal_id
         FROM proposal_status_events
        WHERE event_type IN ('proposal.needs_information', 'proposal.readiness_failed')
     )
   );

UPDATE proposal_pricing_overrides o
   SET target_version_number = COALESCE(
         (
           SELECT v.version_number
             FROM proposal_versions v
            WHERE v.id = o.proposal_version_id
         ),
         (
           SELECT p.current_version_number + 1
             FROM proposals p
            WHERE p.id = o.proposal_id
         ),
         1
       ),
       draft_cycle_number = COALESCE(
         (
           SELECT v.version_number
             FROM proposal_versions v
            WHERE v.id = o.proposal_version_id
         ),
         (
           SELECT p.current_version_number + 1
             FROM proposals p
            WHERE p.id = o.proposal_id
         ),
         1
       );

ALTER TABLE proposals
  DROP CONSTRAINT IF EXISTS proposals_information_cycle_number_check;
ALTER TABLE proposals
  ADD CONSTRAINT proposals_information_cycle_number_check
  CHECK (information_cycle_number >= 0);

ALTER TABLE proposals
  DROP CONSTRAINT IF EXISTS proposals_subtotal_minor_nonnegative;
ALTER TABLE proposals
  ADD CONSTRAINT proposals_subtotal_minor_nonnegative
  CHECK (subtotal_minor >= 0 AND subtotal_minor <= 9007199254740991);

ALTER TABLE proposals
  DROP CONSTRAINT IF EXISTS proposals_total_minor_nonnegative;
ALTER TABLE proposals
  ADD CONSTRAINT proposals_total_minor_nonnegative
  CHECK (total_minor >= 0 AND total_minor <= 9007199254740991);

ALTER TABLE proposal_versions
  DROP CONSTRAINT IF EXISTS proposal_versions_total_minor_nonnegative;
ALTER TABLE proposal_versions
  ADD CONSTRAINT proposal_versions_total_minor_nonnegative
  CHECK (total_minor >= 0 AND total_minor <= 9007199254740991);

ALTER TABLE proposal_line_items
  DROP CONSTRAINT IF EXISTS proposal_line_items_catalog_unit_amount_minor_nonnegative;
ALTER TABLE proposal_line_items
  ADD CONSTRAINT proposal_line_items_catalog_unit_amount_minor_nonnegative
  CHECK (catalog_unit_amount_minor >= 0 AND catalog_unit_amount_minor <= 9007199254740991);

ALTER TABLE proposal_line_items
  DROP CONSTRAINT IF EXISTS proposal_line_items_unit_amount_minor_nonnegative;
ALTER TABLE proposal_line_items
  ADD CONSTRAINT proposal_line_items_unit_amount_minor_nonnegative
  CHECK (unit_amount_minor >= 0 AND unit_amount_minor <= 9007199254740991);

ALTER TABLE proposal_line_items
  DROP CONSTRAINT IF EXISTS proposal_line_items_line_subtotal_minor_nonnegative;
ALTER TABLE proposal_line_items
  ADD CONSTRAINT proposal_line_items_line_subtotal_minor_nonnegative
  CHECK (line_subtotal_minor >= 0 AND line_subtotal_minor <= 9007199254740991);

ALTER TABLE proposal_pricing_overrides
  DROP CONSTRAINT IF EXISTS proposal_pricing_overrides_original_amount_minor_nonnegative;
ALTER TABLE proposal_pricing_overrides
  ADD CONSTRAINT proposal_pricing_overrides_original_amount_minor_nonnegative
  CHECK (original_amount_minor >= 0 AND original_amount_minor <= 9007199254740991);

ALTER TABLE proposal_pricing_overrides
  DROP CONSTRAINT IF EXISTS proposal_pricing_overrides_proposed_amount_minor_nonnegative;
ALTER TABLE proposal_pricing_overrides
  ADD CONSTRAINT proposal_pricing_overrides_proposed_amount_minor_nonnegative
  CHECK (proposed_amount_minor >= 0 AND proposed_amount_minor <= 9007199254740991);

ALTER TABLE proposal_pricing_overrides
  DROP CONSTRAINT IF EXISTS proposal_pricing_overrides_target_version_number_check;
ALTER TABLE proposal_pricing_overrides
  ADD CONSTRAINT proposal_pricing_overrides_target_version_number_check
  CHECK (target_version_number > 0);

ALTER TABLE proposal_pricing_overrides
  DROP CONSTRAINT IF EXISTS proposal_pricing_overrides_draft_cycle_number_check;
ALTER TABLE proposal_pricing_overrides
  ADD CONSTRAINT proposal_pricing_overrides_draft_cycle_number_check
  CHECK (draft_cycle_number > 0);

CREATE UNIQUE INDEX IF NOT EXISTS proposal_pricing_overrides_effective_uidx
  ON proposal_pricing_overrides (proposal_id, target_version_number, line_key)
  WHERE status IN ('requested', 'approved');

CREATE INDEX IF NOT EXISTS proposal_pricing_overrides_target_idx
  ON proposal_pricing_overrides (proposal_id, target_version_number, status);

CREATE INDEX IF NOT EXISTS proposals_information_cycle_idx
  ON proposals (id, information_cycle_number);

ALTER TABLE proposal_line_items
  DROP CONSTRAINT IF EXISTS proposal_line_items_override_id_fkey;
ALTER TABLE proposal_line_items
  ADD CONSTRAINT proposal_line_items_override_id_fkey
  FOREIGN KEY (override_id) REFERENCES proposal_pricing_overrides(id) ON DELETE SET NULL;

DELETE FROM proposal_status_events
 WHERE to_status NOT IN (
   'draft', 'needs_information', 'ready_for_review', 'in_review', 'revision_required',
   'approved', 'ready_for_delivery', 'cancelled', 'superseded'
 );

ALTER TABLE proposal_status_events
  DROP CONSTRAINT IF EXISTS proposal_status_events_from_status_check;
ALTER TABLE proposal_status_events
  ADD CONSTRAINT proposal_status_events_from_status_check
  CHECK (
    from_status IS NULL OR from_status IN (
      'draft', 'needs_information', 'ready_for_review', 'in_review', 'revision_required',
      'approved', 'ready_for_delivery', 'cancelled', 'superseded'
    )
  );

ALTER TABLE proposal_status_events
  DROP CONSTRAINT IF EXISTS proposal_status_events_to_status_check;
ALTER TABLE proposal_status_events
  ADD CONSTRAINT proposal_status_events_to_status_check
  CHECK (
    to_status IN (
      'draft', 'needs_information', 'ready_for_review', 'in_review', 'revision_required',
      'approved', 'ready_for_delivery', 'cancelled', 'superseded'
    )
  );

CREATE UNIQUE INDEX IF NOT EXISTS proposal_reviews_approved_version_uidx
  ON proposal_reviews (proposal_version_id)
  WHERE decision = 'approve';

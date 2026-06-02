-- Conversation pending-state for Follow-Up + Appointment Request (Conversations boundary).
--
-- Two nullable JSONB columns hold a single "open" item each. Shape is enforced
-- by `lib/services/conversation/pending-state.service.ts`; the DB is intentionally
-- permissive so future shape evolution does not require a migration.
--
-- Safe to deploy: nullable columns, no backfill, no index, no constraint.

ALTER TABLE "Conversation"
  ADD COLUMN "pendingFollowUp" JSONB;

ALTER TABLE "Conversation"
  ADD COLUMN "pendingAppointmentRequest" JSONB;

/**
 * Field Catalog v1 — canonical, read-only Source of Truth.
 *
 * 20 entries across 4 namespaces (party / appointment / subject / conversation).
 * 9 are shown in Bot Builder v1; 11 are reserved. Mapping is conservative:
 * only targets in `BOT_FIELD_MAP_TARGETS` are used (today: Customer.name,
 * Customer.phone, Customer.email, Customer.city, Appointment.startsAt). All
 * other fields carry `mapsTo: null` — reserved targets stay unmapped until the
 * allow-list is widened deliberately in a later stage.
 *
 * This is data only. No writer consumes `mapsTo`; no live conversation path
 * imports this module.
 */

import type { CatalogField } from "./field-catalog.types";

export const BOT_FIELD_CATALOG: readonly CatalogField[] = [
  // ── party.* — counterparty identity / contact (Data) ──────────────────────
  {
    key: "party_name",
    namespace: "party",
    fieldClass: "data",
    type: "text",
    mapsTo: "Customer.name",
    builderV1: "shown",
    defaultLabel: "שם",
    defaultQuestion: "מה השם שלך?",
  },
  {
    key: "party_phone",
    namespace: "party",
    fieldClass: "data",
    type: "phone",
    // webhook is the source of truth; a field only completes when empty.
    mapsTo: "Customer.phone",
    builderV1: "shown",
    defaultLabel: "טלפון",
    defaultQuestion: "מה מספר הטלפון שלך?",
  },
  {
    key: "party_email",
    namespace: "party",
    fieldClass: "data",
    type: "email",
    mapsTo: "Customer.email",
    builderV1: "shown",
    defaultLabel: "אימייל",
    defaultQuestion: "מה כתובת האימייל שלך?",
  },
  {
    key: "party_city",
    namespace: "party",
    fieldClass: "data",
    type: "text",
    mapsTo: "Customer.city",
    builderV1: "shown",
    defaultLabel: "עיר",
    defaultQuestion: "מאיזו עיר את/ה?",
  },
  {
    key: "party_legal_name",
    namespace: "party",
    fieldClass: "data",
    type: "text",
    mapsTo: null, // reserved — Customer.legalName not in allow-list yet
    builderV1: "reserved",
    defaultLabel: "שם רשמי / חברה",
    defaultQuestion: "מה השם הרשמי לחשבונית?",
  },
  {
    key: "party_tax_id",
    namespace: "party",
    fieldClass: "data",
    type: "text",
    mapsTo: null, // reserved — Customer.taxId not in allow-list yet
    builderV1: "reserved",
    defaultLabel: "ע.מ / ח.פ",
    defaultQuestion: "מה מספר העוסק/החברה?",
  },

  // ── appointment.* — scheduling (Data) ─────────────────────────────────────
  {
    key: "appointment_date",
    namespace: "appointment",
    fieldClass: "data",
    type: "date",
    mapsTo: "Appointment.startsAt",
    builderV1: "shown",
    defaultLabel: "תאריך",
    defaultQuestion: "לאיזה תאריך תרצה/י לקבוע?",
  },
  {
    key: "appointment_datetime",
    namespace: "appointment",
    fieldClass: "data",
    type: "datetime",
    // same destination as appointment_date; kept as a separate key by decision.
    mapsTo: "Appointment.startsAt",
    builderV1: "reserved", // until field parsing exists
    defaultLabel: "תאריך ושעה",
    defaultQuestion: "מתי נוח לך? (תאריך ושעה)",
  },
  {
    key: "appointment_duration",
    namespace: "appointment",
    fieldClass: "data",
    type: "select",
    mapsTo: null, // reserved — Appointment.durationMinutes not in allow-list yet
    builderV1: "reserved",
    defaultLabel: "משך",
    defaultQuestion: "כמה זמן נדרש בערך?",
  },

  // ── subject.* — facts about the inquiry subject (Data, generic-now) ───────
  {
    key: "service_type",
    namespace: "subject",
    fieldClass: "data",
    type: "select",
    mapsTo: null, // stays generic by decision (not mapped to Appointment.title)
    builderV1: "shown",
    defaultLabel: "סוג שירות",
    defaultQuestion: "איזה שירות מעניין אותך?",
  },
  {
    key: "subject_vehicle_number",
    namespace: "subject",
    fieldClass: "data",
    type: "text",
    mapsTo: null,
    builderV1: "reserved",
    defaultLabel: "מספר רכב",
    defaultQuestion: "מה מספר הרכב?",
  },
  {
    key: "subject_vehicle_model",
    namespace: "subject",
    fieldClass: "data",
    type: "text",
    mapsTo: null,
    builderV1: "reserved",
    defaultLabel: "דגם רכב",
    defaultQuestion: "איזה רכב יש לך?",
  },
  {
    key: "subject_seats_count",
    namespace: "subject",
    fieldClass: "data",
    type: "select",
    mapsTo: null,
    builderV1: "reserved",
    defaultLabel: "מספר סועדים",
    defaultQuestion: "לכמה סועדים?",
    options: [
      { value: "1-2", label: "1–2" },
      { value: "3-4", label: "3–4" },
      { value: "5+", label: "5 ומעלה" },
    ],
  },
  {
    key: "subject_guests_count",
    namespace: "subject",
    fieldClass: "data",
    type: "select",
    mapsTo: null,
    builderV1: "reserved",
    defaultLabel: "מספר אורחים",
    defaultQuestion: "כמה אורחים צפויים?",
    options: [
      { value: "1-20", label: "עד 20" },
      { value: "21-50", label: "21–50" },
      { value: "51-100", label: "51–100" },
      { value: "100+", label: "100 ומעלה" },
    ],
  },
  {
    key: "subject_property_address",
    namespace: "subject",
    fieldClass: "data",
    type: "text",
    mapsTo: null,
    builderV1: "reserved",
    defaultLabel: "כתובת",
    defaultQuestion: "מה הכתובת לטיפול?",
  },

  // ── conversation.* — chat-advancing (Conversation, generic) ───────────────
  {
    key: "preferred_contact_time",
    namespace: "conversation",
    fieldClass: "conversation",
    type: "select",
    mapsTo: null,
    builderV1: "shown",
    defaultLabel: "זמן מועדף ליצירת קשר",
    defaultQuestion: "מתי נוח לך שניצור קשר?",
    options: [
      { value: "morning", label: "בוקר" },
      { value: "afternoon", label: "צהריים" },
      { value: "evening", label: "ערב" },
    ],
  },
  {
    key: "anything_else",
    namespace: "conversation",
    fieldClass: "conversation",
    type: "text",
    mapsTo: null,
    builderV1: "shown",
    defaultLabel: "עוד משהו",
    defaultQuestion: "יש עוד משהו שכדאי שנדע?",
  },
  {
    key: "notes",
    namespace: "conversation",
    fieldClass: "conversation",
    type: "text",
    mapsTo: null, // generic only by decision
    builderV1: "shown",
    defaultLabel: "הערות",
    defaultQuestion: "הערות נוספות?",
  },
  {
    key: "budget_range",
    namespace: "conversation",
    fieldClass: "conversation",
    type: "select",
    mapsTo: null,
    builderV1: "reserved",
    defaultLabel: "טווח תקציב",
    defaultQuestion: "מה טווח התקציב שלך?",
  },
  {
    key: "how_did_you_hear_about_us",
    namespace: "conversation",
    fieldClass: "conversation",
    type: "select",
    mapsTo: null,
    builderV1: "reserved",
    defaultLabel: "איך שמעת עלינו",
    defaultQuestion: "איך הגעת אלינו?",
  },
];

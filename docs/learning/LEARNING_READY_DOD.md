# Learning-ready: Definition of Done for business features

A business feature is not **learning-ready** until each meaningful action it adds has been
evaluated against this checklist, and the outcome is recorded in
[`SENSOR_COVERAGE.md`](./SENSOR_COVERAGE.md).

This does **not** mean every feature needs a learning rule. It means someone decided, on purpose,
whether the Business Brain will need to know that the action happened, and made sure it can.

## What counts as a "meaningful action"

A meaningful action is a **business** occurrence: something was created, decided, corrected,
approved, rejected, issued, paid, reversed, received, sent or changed in a way that changes what is
true about the business.

These are **not** meaningful actions and must not become sensors:

- opening a page, scrolling, switching tabs, hovering
- viewing a record
- anything purely cosmetic

The exception is a specific product requirement that proves one of these is business-significant.

## The checklist

For each meaningful action:

| # | Question | Where the answer goes |
|---|---|---|
| 1 | **Sensor / evidence.** Which record proves it happened? Is it the domain row itself, a domain ledger (`BillingAuditEvent`, `PaymentAuditEvent`, `PayablesAuditEvent`, `ReviewEvent`, `CollectionAction`), or a sensor in `lib/sensors/catalogue.ts`? Do not duplicate an authoritative ledger. | manifest `authoritativeSource` / `sensor` |
| 2 | **Actor.** Who caused it: a person of this business (`OWNER_USER` with a user id), Dubiz (`SYSTEM`), an external system (`INTEGRATION`), or genuinely `UNKNOWN`? Take it from the server session, never from a request body. Never infer it from who owns the business. | manifest `actor` |
| 3 | **Source.** Through which channel: `OWNER_UI`, `IMPORT`, `INTEGRATION`, `SYSTEM`, `API`? An import must not look identical to manual entry if learning could depend on origin. | manifest `source` |
| 4 | **Tenant.** Is `businessId` server-derived? Is every id taken from input (customer, lead, suggestion…) verified to belong to this business before it is stored? Is any new table under ENABLE + FORCE RLS, with grants in the same migration, proven under a NOBYPASSRLS runtime role? | battery |
| 5 | **Entity identity.** Which entity does the action concern, by id? Never by a name that looks similar. Weak signals propose; only the owner or authoritative evidence confirms. | manifest `entity` |
| 6 | **Correction / reversal.** Can the action be edited, cancelled, voided, reversed, reopened or deleted? Does the reversal leave its own trace, without erasing the original? | manifest `reversal` |
| 7 | **Machine vs owner.** If a machine proposed something the owner then accepted or changed, are both values preserved? | manifest `notes` |
| 8 | **Learning consumer.** Which rule consumes it, or which planned question it answers. `null` is a legitimate answer. | manifest `consumer` |
| 9 | **Privacy.** Does the sensor payload hold only ids, enum values, flags, counts and field **names**? No names, phones, emails, message text, free-text reasons, document content, tokens, or raw external payloads. Is nothing sensitive printed to logs or CI output? | `lib/sensors/sensors.test.ts` enforces this for sensor payloads |
| 10 | **Retention / deletion.** What happens to the evidence when the business is erased? Is it listed in `scripts/ci/erasure/erasure-model-coverage.ts`? | erasure register |
| 11 | **Replay / idempotency.** Can the action be retried (webhook, cron, import, double-click)? A retry must not become a second business fact. Use the source's stable id as `idempotencyKey`. | sensor call |
| 12 | **Outcome potential.** Will the action later have an outcome worth learning from (paid, converted, cancelled)? If so, is the link from action to outcome authoritative (a foreign key, a shared id), and not coincidental timing? | manifest `notes` |

## Sensor rules (from `lib/sensors/sensor.contract.ts`)

- **A sensor reports what happened. A rule decides what it means.** For example,
  `LEAD_MARKED_LOST` is a sensor name and `LEAD_WAS_LOW_QUALITY` is not. Likewise
  `INVENTORY_QUANTITY_CORRECTED` is a sensor name and `DEMAND_INCREASED` is not.
- Use `recordSensor` for new sensors. It requires an actor **and** a source. It refuses keys outside
  the catalogue, keys that name personal data, strings longer than 100 characters, and objects.
- **Failure behavior depends on whether the event is authoritative.**
  - Sensors are learning evidence about an action that is already recorded in its own table, so they
    **fail open**: a sensor must never stop a business action.
  - Where the event is part of an authoritative operation (issuing, settling, paying), the domain
    ledger is written in the same transaction, and it is **not** fail-open.
- Inside a transaction, pass `{ tx }` so the sensor is atomic with the action.
- Never backfill an actor or source that was not recorded. A historical `NULL` stays `NULL`.

## When the checklist is done

Add or update the feature's rows in [`SENSOR_COVERAGE.md`](./SENSOR_COVERAGE.md). A pull request
that adds a meaningful business action without a manifest row is not done.

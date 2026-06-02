# Platform Feature Access — v1 Foundation (Phase 0–2A)

Per-business feature access foundation. **No enforcement** on business routes (Phase 2A).

## Feature catalog (code)

Source of truth: `lib/services/feature-access/platform-feature-catalog.ts`

- `PLATFORM_FEATURE_KEYS` — stable string keys (`as const`)
- `PLATFORM_FEATURE_CATALOG` — displayName, category, defaultEnabled, mutable, description

Adding a feature requires:

1. Entry in catalog (code)
2. Rows in `PlatformFeatureDefinition` + `PlatformFeaturePolicy` (migration/seed)

## Schema

| Table | Purpose |
|-------|---------|
| `PlatformFeatureDefinition` | Catalog mirror (key PK) |
| `PlatformFeaturePolicy` | Global default + `emergencyDisabled` |
| `BusinessFeatureAccess` | Sparse per-business overrides |

Enum `BusinessFeatureAccessState`: `ENABLED` | `DISABLED` | `INHERIT`

**Sparse model:** only `ENABLED` / `DISABLED` rows are stored. API `INHERIT` **deletes** the override row. Do not persist `INHERIT` rows.

Seed: all features `globalEnabled=true`, `emergencyDisabled=false`.

## Resolution precedence (implemented)

1. `emergencyDisabled` (global policy)
2. Business override `DISABLED`
3. Business override `ENABLED`
4. `globalEnabled` (policy)
5. Catalog `defaultEnabled`

**Not implemented yet:** plans, trials (`expiresAt`), rollout percent, env kill switch for reads.

## Services

| Function | Purpose |
|----------|---------|
| `resolveFeatureAccess(businessId, featureKey)` | Single feature effective access |
| `resolveBusinessCapabilities(businessId)` | All catalog keys |
| `updateBusinessFeatureAccess(...)` | Platform-admin override mutation (Phase 2A) |
| `requireFeatureAccess` | Throws `FeatureAccessDeniedError` — **not wired to routes** |

## Kill switch (mutations only)

```env
FEATURE_ACCESS_MUTATIONS_ENABLED=true
```

When not `true`, `PATCH` returns **503** with no DB changes.

## APIs

| Method | Path | Auth |
|--------|------|------|
| GET | `/api/platform-admin/businesses/[id]/features` | Platform admin |
| PATCH | `/api/platform-admin/businesses/[id]/features/[featureKey]` | Platform admin |
| GET | `/api/business/capabilities` | Business user (Bearer) |

### PATCH body

```json
{
  "state": "ENABLED" | "DISABLED" | "INHERIT",
  "reason": "required, 10–500 chars after trim"
}
```

### PATCH response (200)

```json
{
  "changed": true,
  "generatedAt": "...",
  "business": { "id": 1, "name": "..." },
  "feature": { "...PlatformAdminBusinessFeatureItem" }
}
```

### PATCH errors

| Status | Code | When |
|--------|------|------|
| 400 | — | Invalid body / reason length |
| 403 | `FEATURE_NOT_MUTABLE` | `mutable=false` in catalog |
| 404 | — | Unknown business or featureKey |
| 409 | `NO_CHANGE` | No effective diff |
| 503 | — | Mutations kill switch off |

### Audit (transactional)

Action: `PLATFORM_FEATURE_ACCESS_UPDATED`

Metadata: `businessId`, `featureKey`, `oldState`, `newState`, `reason`, `effectiveAllowedAfter`, `reasonCodeAfter`

Mutation + audit run in the **same** `prisma.$transaction`. Audit failure rolls back the override change.

## Future phases (not started)

- Phase 2B: Admin UI write controls (minimal panel + confirm)
- `requireFeatureAccess` on mutation routes (gradual)
- Subscription plans (`PlanFeatureAccess`)
- Global emergency PATCH UI
- Rollout percent / trial expiry

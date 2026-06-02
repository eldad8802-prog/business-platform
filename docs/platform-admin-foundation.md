# Platform Admin — Security Foundation (read-only APIs)

Schema-only migration; admin users are **not** created by migrations.

## Environment

```env
# Comma-separated allowlist (defense-in-depth with User.role = PLATFORM_ADMIN)
PLATFORM_ADMIN_EMAILS=you@example.com
```

When `PLATFORM_ADMIN_EMAILS` is set, the email must appear in the list **and** the user must have `role = PLATFORM_ADMIN`.

## 1. Apply migration

```powershell
cd c:\dev\business-platform
npx prisma migrate deploy
npx prisma generate
```

## 2. Create System Business (once per database)

```sql
INSERT INTO "Business" ("name", "createdAt", "updatedAt")
VALUES ('__PLATFORM_SYSTEM__', NOW(), NOW())
ON CONFLICT DO NOTHING;
```

If your DB has no unique constraint on `name`, run a single insert only when missing:

```sql
INSERT INTO "Business" ("name", "createdAt", "updatedAt")
SELECT '__PLATFORM_SYSTEM__', NOW(), NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM "Business" WHERE "name" = '__PLATFORM_SYSTEM__'
);
```

Note the `id` (e.g. `SELECT id FROM "Business" WHERE "name" = '__PLATFORM_SYSTEM__'`).

## 3. Promote an existing user OR create a dedicated admin

### Option A — Promote existing user (dev only)

```sql
UPDATE "User"
SET "role" = 'PLATFORM_ADMIN'
WHERE "email" = 'admin@example.com';
```

Ensure `PLATFORM_ADMIN_EMAILS` includes that email.

### Option B — New admin user (recommended)

1. Register normally via `/api/auth/register` **or** use an existing account.
2. Move user to system business and set role:

```sql
UPDATE "User"
SET
  "role" = 'PLATFORM_ADMIN',
  "businessId" = (SELECT id FROM "Business" WHERE "name" = '__PLATFORM_SYSTEM__' LIMIT 1)
WHERE "email" = 'admin@example.com';
```

Password remains whatever was set at registration (bcrypt in DB). Do not put credentials in migrations.

## 4. Call admin APIs

```http
Authorization: Bearer <userId>
```

- `GET /api/platform-admin/overview`
- `GET /api/platform-admin/businesses?page=1&limit=20`

## APIs

| Endpoint | Description |
|----------|-------------|
| `GET /api/platform-admin/overview` | Cross-tenant counts |
| `GET /api/platform-admin/businesses` | Paginated business list (excludes `__PLATFORM_SYSTEM__`) |

Access is logged to `PlatformAuditEvent`.

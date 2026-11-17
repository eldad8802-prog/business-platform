-- When schema.prisma models the declaration tables (the #1081 code PR), `prisma db push` builds them WITHOUT the
-- migration's triggers, policies, functions and grants. Labs drop what db push built so the migration builds them
-- the way Production will have them (the same move as .agl/lab.sh for UserIdentity). Lab only.
DROP TABLE IF EXISTS "BusinessIssuerDeclaration", "BillingSeriesOpening", "IssuerDeclarationEnforcement" CASCADE;
DROP TYPE IF EXISTS "IssuerTrack", "IssuerLegalForm", "IssuerVatStatus", "IssuerIdType", "IssuerDeclarationKind",
  "IssuerAuthorityBasis", "IssuerReauthMethod", "SeriesOpeningSource";

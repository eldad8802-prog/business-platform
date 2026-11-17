# Follow-up migration (after #1148 + declaration code live): correction after a live issuer declaration
Owner decision pending (joint dd + 4a). Contract from 4a, 11-17 (20261126100000 chain guard):
- new BusinessIssuerDeclaration row kind CORRECTION: version=cur.version+1, supersedesId=cur.id, effectiveFrom=now()
- declaredByUserId = cur.authorizedUserId (NOT the approver; approver stays on request.decidedByUserId); authorizedUserId = cur.authorizedUserId
- authorityBasis = CURRENT_AUTHORIZED_USER (avoid PLATFORM_DESIGNATED)
- reauthMethod in {PASSWORD, EMAIL_LINK}: our request has PASSWORD | RECENT_SIGN_IN -> RECENT_SIGN_IN has NO mapping. Open issue:
  either require PASSWORD re-verification for declared businesses, or 4a adds a value (their migration).
- the requester may not be cur.authorizedUserId -> decide must refuse/handle (DZD33) unless requester == authorized user. Open issue.
- statementVersion 'issuer-correction-v1', statementSha256 = sha256(canonical text over approved request), 64 lowercase hex; 4a mirrors in reader
- legalForm/idType/track consistent (we already refuse individual<->company)
- vatRegistrationNumber NOT NULL unless EXEMPT, 9 digits -> request needs requestedVatNumber (owner decision)
Owner policy blockers (4a presents): ISSUER_CORRECTION_AFTER_ISSUANCE_REFUSED (any fiscal doc since effectiveFrom blocks any correction); legal-name typo after issuance also refused.

## Owner decisions AS RELAYED BY 4a (11-17), to be confirmed directly with the owner in the consolidated report
1. requestedVatNumber joins the correction request (no separate path)
2. declared business: only cur.authorizedUserId may request a correction  -> settles gap (b)
3. declared business: PASSWORD re-verification required (no RECENT_SIGN_IN) -> settles gap (a)
4. forward correction after issuance: approved in principle only; first separate technical detail fix vs legal identity change, legal implications, permission bounds + migrations (chain guard = 4a)
5. follow-up migration in dd track: direction approved in principle; the migration itself still needs explicit approval

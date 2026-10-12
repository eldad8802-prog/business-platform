\pset pager off
SELECT current_user,
 has_any_column_privilege('public."Business"','INSERT') AS biz_ins,
 has_any_column_privilege('public."User"','INSERT') AS user_ins,
 has_any_column_privilege('public."AuthSession"','INSERT') AS sess_ins,
 has_any_column_privilege('public."TransactionalEmail"','INSERT') AS te_ins,
 has_column_privilege('public."User"','password','INSERT') AS pw_ins,
 has_column_privilege('public."User"','password','UPDATE') AS pw_upd,
 has_column_privilege('public."User"','tokenVersion','UPDATE') AS tv_upd,
 has_column_privilege('public."User"','emailVerifiedAt','SELECT') AS ev_sel,
 has_column_privilege('public."User"','emailVerifiedAt','UPDATE') AS ev_upd;

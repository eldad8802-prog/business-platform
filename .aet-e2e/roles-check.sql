\pset pager off
SELECT current_user,
 has_table_privilege('public."Business"','INSERT') AS biz_ins,
 has_table_privilege('public."User"','INSERT') AS user_ins,
 has_table_privilege('public."AuthSession"','INSERT') AS sess_ins,
 has_table_privilege('public."TransactionalEmail"','INSERT') AS te_ins,
 has_column_privilege('public."User"','password','UPDATE') AS pw_upd,
 has_table_privilege('public."AuthEmailToken"','SELECT') AS aet_sel,
 has_function_privilege('public.auth_email_token_issue(integer,text,uuid,text)','EXECUTE') AS f_issue,
 has_function_privilege('public.auth_email_token_check(uuid,text,text)','EXECUTE') AS f_check,
 has_function_privilege('public.auth_email_verify_consume(uuid,text)','EXECUTE') AS f_verify,
 has_function_privilege('public.auth_password_reset_consume(uuid,text,text)','EXECUTE') AS f_reset;
SELECT public.auth_email_token_check('00000000-0000-0000-0000-000000000000'::uuid,'x','EMAIL_VERIFY') AS check_call;
SELECT * FROM public.auth_email_verify_consume('00000000-0000-0000-0000-000000000000'::uuid,'x');
\set ON_ERROR_STOP 0
BEGIN; UPDATE public."User" SET password = 'x' WHERE id = -1; ROLLBACK;
SELECT count(*) FROM public."AuthEmailToken";

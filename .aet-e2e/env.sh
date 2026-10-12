# Local lab env only (aet_e2e on 127.0.0.1:55531). Synthetic credentials only.
export OWNER_URL="postgresql://lab_super:aet_ci_synthetic_super_pw@127.0.0.1:55531/aet_e2e"
export DATABASE_URL="postgresql://aete2e_runtime_login:aete2e_synthetic_runtime_pw@127.0.0.1:55531/aet_e2e"
export AUTH_DATABASE_URL="postgresql://aete2e_auth_login:aete2e_synthetic_auth_pw@127.0.0.1:55531/aet_e2e"
export DIRECT_URL="$OWNER_URL"
export AUTH_PLANE_ENABLED=true
export AUTH_TOKEN_SECRET="aete2e-synthetic-auth-token-secret-0123456789abcdef0123456789abc"
export RATE_LIMIT_BACKEND=memory
export PUBLIC_SIGNUP_ENABLED=true
export TRANSACTIONAL_EMAIL_ENABLED=true
export RESEND_API_KEY=re_fake_not_a_key
export TRANSACTIONAL_EMAIL_FROM="Dubiz <hello@example.test>"
export APP_BASE_URL=http://localhost:3571
export NEXT_TELEMETRY_DISABLED=1
export NEXT_FONT_GOOGLE_MOCKED_RESPONSES="C:/dev/bp-auth-rec/.aet-e2e/fonts-mock.cjs"
export NODE_OPTIONS="--require C:/dev/bp-auth-rec/.aet-e2e/fake-resend.cjs"
if [ "${FLAGS:-on}" = "on" ]; then
  export AUTH_EMAIL_VERIFICATION_ENABLED=true
  export AUTH_PASSWORD_RESET_ENABLED=true
else
  unset AUTH_EMAIL_VERIFICATION_ENABLED AUTH_PASSWORD_RESET_ENABLED
fi
unset SIGNUP_ALLOWED_EMAILS UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN

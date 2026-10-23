# Enterprise SSO

The login screen supports SAML SSO through Supabase Auth. The feature is off by
default and does not replace local administrator access until the client's
identity-provider rollout and recovery procedure have been tested.

Configure the client's SAML connection in Supabase, allow the exact callback
origin, then set either its provider ID or a verified domain:

```text
ENTERPRISE_SSO_ENABLED=true
ENTERPRISE_SSO_LABEL=Clinic SSO
ENTERPRISE_SSO_PROVIDER_ID=<Supabase SSO provider ID>
# Or, instead of provider ID:
# ENTERPRISE_SSO_DOMAIN=staff.example.org
```

The server constructs the callback from `NEXT_PUBLIC_SITE_URL`; browser input
cannot choose it. Callback return paths reject cross-origin and backslash forms.
First-time SSO users receive an inactive least-privilege profile and go to the
existing administrator approval queue. SSO therefore authenticates identity but
does not assign application authorization.

Before enabling it, the client must provide the IdP metadata, verified domains,
attribute/NameID mapping, session and MFA policy, break-glass account owners,
certificate-rotation contacts, and staging test identities for every staff role.

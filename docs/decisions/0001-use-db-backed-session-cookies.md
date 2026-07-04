# 0001. Use DB-Backed Session Cookies Instead of JWT Session Cookies

Status: Accepted

Date: 2026-06-13

## Context

The dashboard authenticates users with Google Identity Services. After Google
sign-in, the browser receives a Google ID token and sends it to our backend. The
backend verifies that token with Google, stores or updates the user record, and
then needs to create an application session for future dashboard API requests.

The obvious alternative is to issue our own JWT after Google login:

```text
Google ID token -> backend verifies Google token -> backend signs app JWT -> browser stores JWT cookie
```

That would use a `JWT_PRIVATE_KEY` to sign tokens and a `JWT_PUBLIC_KEY` to
verify them. The current implementation instead uses an opaque session cookie:

```text
Google ID token -> backend verifies Google token -> backend creates random session token
browser cookie contains random token
database stores hash(token) -> user_id, expires_at
```

This decision needs justification because JWTs are common, portable, and can
avoid a database lookup on every request.

## Decision

Use an HTTP-only, secure, same-site cookie containing an opaque random session
token. Store only a hash of that token in Postgres, linked to the user and an
expiration timestamp.

Do not issue our own JWT for dashboard sessions at this stage.

## Why This Is Better for This Use Case

This product is a control-plane dashboard for API key minting, revocation,
usage metering, and billing. The most important session properties are:

- immediate revocation
- strong auditability
- simple incident response
- server-side control over active sessions
- low operational complexity while the backend is still small

DB-backed sessions fit those properties better than JWT session cookies.

The application already depends on Postgres for users, API keys, usage events,
and billing state. Avoiding one session lookup is not worth adding JWT signing
keys, key rotation, token revocation lists, and stale-claim handling.

## JWT Session Cookie Pros

JWTs are not wrong. They are useful when their strengths match the system.

Pros:

- Stateless verification: the server can validate a JWT without a database
  lookup.
- Good for distributed systems where many services need to verify identity
  independently.
- Claims can be embedded in the token, such as `user_id`, `role`, `tenant_id`,
  or `exp`.
- Public/private key signing supports verification by services that should not
  have signing authority.
- They work well for short-lived service-to-service or API authorization tokens.

Those are real advantages, especially when the system has multiple independent
services and the cost or reliability impact of a central session lookup is high.

## JWT Session Cookie Cons

JWTs become awkward for browser dashboard sessions because a signed token stays
valid until it expires unless the backend adds more state.

Cons:

- Immediate logout is hard. The browser can delete its cookie, but a stolen JWT
  remains valid until expiration.
- Immediate admin revocation requires a denylist, token version, or session
  table, which removes the main stateless benefit.
- User changes can become stale. If email, role, tenant access, billing status,
  or account disabled state changes, existing JWTs may still carry old claims.
- Key rotation must be designed and tested. The system needs `kid` headers,
  active and retired keys, expiry windows, and rollout procedures.
- A leaked private key is severe. Every active token may need to be invalidated.
- Long-lived JWTs are risky. Short-lived JWTs require refresh-token machinery,
  which is another stateful session system.
- Debugging and incident response often end up needing server-side records
  anyway: active sessions, device metadata, last seen time, and revocation time.

For this app, those costs show up early because API keys and billing require
clear ownership and revocation semantics.

## DB-Backed Session Cookie Pros

Pros:

- Immediate revocation: delete one `sessions` row.
- Logout is authoritative: remove the session server-side and clear the cookie.
- Admin actions are straightforward: revoke one session or all sessions for a
  user.
- Stolen session response is simple: delete the session row.
- The cookie contains no user claims or billing data.
- Only a hash of the session token is stored, so database disclosure does not
  directly expose usable session cookies.
- Session records support audit fields over time, such as `created_at`,
  `expires_at`, `last_seen_at`, IP, user agent, or device name.
- It matches the rest of this app's state model. Users, API keys, usage, and
  billing already live in Postgres.

## DB-Backed Session Cookie Cons

Cons:

- Every authenticated dashboard API request needs a database lookup.
- The session database is on the critical path for dashboard auth.
- Horizontal scaling must ensure all app instances can reach the same session
  store.
- Sessions are not directly verifiable by independent services.

These are acceptable tradeoffs here. The dashboard backend already needs
Postgres for API keys and usage data, and dashboard traffic is not the part of
the system expected to require stateless, high-throughput identity verification.

## Security Model

The cookie value is a random opaque token. It is not a JWT and does not contain
claims.

The database stores:

```text
hash(session_token, SESSION_SECRET) -> user_id, expires_at
```

The cookie should be:

- `HttpOnly`
- `SameSite=Lax`
- `Secure` in production
- scoped to `/`
- given a finite expiration

The backend validates each request by hashing the cookie value and looking up a
non-expired session row.

## Relationship to Google Identity

Google signs the Google ID token using Google's keys. Our backend verifies that
token with Google public keys through `google-auth-library`.

That Google ID token is not our application session. It is an input to login.
After login, our system owns the session lifecycle.

Use Google's stable `sub` claim as the user's external identity key. Do not use
email as the primary identity key because email can change.

## When We Should Reconsider JWTs

Reconsider issuing first-party JWTs if we later need:

- independent services to verify user identity without calling the dashboard
  backend
- short-lived access tokens for service-to-service authorization
- edge authorization where database access is too expensive
- a dedicated API gateway that validates signed tokens before forwarding traffic
- integration with a managed identity platform that provides session cookie or
  token lifecycle management

Even then, JWTs should probably be introduced for service/API authorization,
not as a replacement for browser dashboard sessions unless revocation and key
rotation are fully designed.

## Consequences

The backend must keep the `sessions` table available for dashboard API access.

Session revocation and logout remain simple.

The system avoids managing `JWT_PUBLIC_KEY` and `JWT_PRIVATE_KEY` for browser
sessions.

If stateless identity becomes necessary later, it can be added as a separate
token layer without changing the Google login flow or API key ownership model.

import { randomUUID } from "node:crypto";
import type { AstroCookies } from "astro";
import { OAuth2Client } from "google-auth-library";
import { hashSessionToken, randomToken } from "./crypto";
import { isProduction, requireEnv } from "./env";
import { query } from "./db";

export const SESSION_COOKIE = "cp_session";
const SESSION_DAYS = 14;

export type User = {
  id: string;
  google_sub: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
};

type SessionUserRow = User & {
  expires_at: Date;
};

type GoogleUser = {
  googleSub: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

let googleClient: OAuth2Client | undefined;

function getGoogleClientId() {
  return process.env.GOOGLE_CLIENT_ID ?? requireEnv("PUBLIC_GOOGLE_CLIENT_ID");
}

function getGoogleClient() {
  googleClient ??= new OAuth2Client(getGoogleClientId());
  return googleClient;
}

export async function verifyGoogleCredential(credential: string): Promise<GoogleUser> {
  const ticket = await getGoogleClient().verifyIdToken({
    idToken: credential,
    audience: getGoogleClientId(),
  });
  const payload = ticket.getPayload();

  if (!payload?.sub || !payload.email) {
    throw new Error("Google credential did not include required identity fields.");
  }

  return {
    googleSub: payload.sub,
    email: payload.email,
    name: payload.name ?? null,
    avatarUrl: payload.picture ?? null,
  };
}

export async function upsertUserFromGoogle(googleUser: GoogleUser) {
  const result = await query<User>(
    `
      insert into users (id, google_sub, email, name, avatar_url)
      values ($1, $2, $3, $4, $5)
      on conflict (google_sub) do update set
        email = excluded.email,
        name = excluded.name,
        avatar_url = excluded.avatar_url,
        updated_at = now()
      returning id, google_sub, email, name, avatar_url
    `,
    [
      randomUUID(),
      googleUser.googleSub,
      googleUser.email,
      googleUser.name,
      googleUser.avatarUrl,
    ],
  );

  return result.rows[0];
}

export async function createSession(userId: string) {
  const token = randomToken();
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await query(
    `
      insert into sessions (id, user_id, token_hash, expires_at)
      values ($1, $2, $3, $4)
    `,
    [randomUUID(), userId, tokenHash, expiresAt],
  );

  return { token, expiresAt };
}

export function setSessionCookie(
  cookies: AstroCookies,
  token: string,
  expiresAt: Date,
) {
  cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(cookies: AstroCookies) {
  cookies.delete(SESSION_COOKIE, {
    path: "/",
  });
}

export async function getCurrentUser(cookies: AstroCookies) {
  const token = cookies.get(SESSION_COOKIE)?.value;

  if (!token) {
    return null;
  }

  const result = await query<SessionUserRow>(
    `
      select u.id, u.google_sub, u.email, u.name, u.avatar_url, s.expires_at
      from sessions s
      join users u on u.id = s.user_id
      where s.token_hash = $1 and s.expires_at > now()
      limit 1
    `,
    [hashSessionToken(token)],
  );

  return result.rows[0] ?? null;
}

export async function revokeCurrentSession(cookies: AstroCookies) {
  const token = cookies.get(SESSION_COOKIE)?.value;

  if (token) {
    await query("delete from sessions where token_hash = $1", [
      hashSessionToken(token),
    ]);
  }

  clearSessionCookie(cookies);
}

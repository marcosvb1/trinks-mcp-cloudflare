import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";

/**
 * Cloudflare Access (Managed OAuth) puts a signed JWT on every allowed request,
 * in the `Cf-Access-Jwt-Assertion` header. Verifying it is the security bar the
 * Cloudflare docs require: a valid token means the caller cleared the Access
 * policy (i.e. is in your org). Without this check, Managed OAuth can be bypassed.
 *
 * JWKS: https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
 */

// One JWKS set per team domain, reused across requests in the same isolate.
let jwksCache: { domain: string; set: ReturnType<typeof createRemoteJWKSet> } | null = null;

function getJwks(teamDomain: string) {
  if (!jwksCache || jwksCache.domain !== teamDomain) {
    jwksCache = { domain: teamDomain, set: createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`)) };
  }
  return jwksCache.set;
}

/** Normalize to `https://<team>.cloudflareaccess.com` (no trailing slash). */
function normalizeTeamDomain(raw: string): string {
  let d = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(d)) d = `https://${d}`;
  return d;
}

/**
 * Verify the Access JWT. Returns the caller's email (or subject) on success,
 * or null if the header is missing/invalid — caller turns null into a 401.
 */
export async function verifyAccessJwt(request: Request, env: Env): Promise<string | null> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;

  const teamDomain = normalizeTeamDomain(env.ACCESS_TEAM_DOMAIN);
  try {
    const { payload } = await jwtVerify(token, getJwks(teamDomain), {
      issuer: teamDomain,
      audience: env.ACCESS_AUD,
    });
    return (payload.email as string | undefined) ?? (payload.sub as string | undefined) ?? "unknown";
  } catch {
    return null;
  }
}

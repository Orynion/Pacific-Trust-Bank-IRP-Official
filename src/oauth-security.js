// Pure helpers for Roblox OAuth hardening, kept separate from index.js so the
// interaction-free logic is unit-testable.

/**
 * Returns true only when the request's host exactly matches the host of the
 * registered redirect URI. Blocks OAuth callbacks delivered through
 * attacker-controlled domains, DNS-rebinding hosts, suffix-spoofed domains, or
 * unexpected ports — all of which would otherwise reach the same socket.
 *
 * The scheme (http/https) is deliberately ignored: deployments behind a
 * TLS-terminating proxy (e.g. Render) receive the request as plain HTTP.
 */
export function isAllowedCallbackHost(requestOriginOrUrl, configuredRedirectUri) {
  try {
    const configured = new URL(configuredRedirectUri);
    const incoming = new URL(requestOriginOrUrl);
    return incoming.host === configured.host;
  } catch {
    return false;
  }
}

/**
 * Builds the OAuth token exchange body. RFC 6749 §4.1.3 requires redirect_uri
 * on the token request whenever it was included in the authorization request,
 * so it must be the exact registered value.
 */
export function buildTokenRequestBody(code, codeVerifier, redirectUri) {
  return new URLSearchParams({
    client_id: process.env.ROBLOX_CLIENT_ID,
    client_secret: process.env.ROBLOX_CLIENT_SECRET,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
}

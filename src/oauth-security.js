// Pure helpers for Roblox OAuth hardening, kept separate from index.js so the
// interaction-free logic is unit-testable.

/**
 * Sanitizes an OAuth configuration value by trimming whitespace and removing
 * surrounding single or double quotes.
 */
export function sanitizeOAuthValue(value) {
  if (value === undefined || value === null) return "";
  const str = String(value).trim();
  // Strip enclosing quotes if present (e.g. "12345" or '12345')
  return str.replace(/^["'](.*)["']$/, "$1").trim();
}

/**
 * Retrieves and sanitizes Roblox OAuth credentials from the environment.
 * Prioritizes ROBLOX_CLIENT_ID / ROBLOX_CLIENT_SECRET, with fallback to CLIENT_ID / CLIENT_SECRET
 * if the Roblox-specific variable is absent.
 */
export function getRobloxOAuthCredentials(env = process.env) {
  const rawClientId = env.ROBLOX_CLIENT_ID ?? env.CLIENT_ID ?? "";
  const rawClientSecret = env.ROBLOX_CLIENT_SECRET ?? env.CLIENT_SECRET ?? "";
  const rawRedirectUri = env.ROBLOX_REDIRECT_URI ?? (env.APP_URL ? `${sanitizeOAuthValue(env.APP_URL)}/oauth/roblox/callback` : "http://localhost:3000/oauth/roblox/callback");

  return {
    clientId: sanitizeOAuthValue(rawClientId),
    clientSecret: sanitizeOAuthValue(rawClientSecret),
    redirectUri: sanitizeOAuthValue(rawRedirectUri),
  };
}

/**
 * Validates the Roblox OAuth configuration without exposing any secrets.
 */
export function validateRobloxOAuthConfig(env = process.env) {
  const credentials = getRobloxOAuthCredentials(env);
  const missing = [];
  const errors = [];

  const isInvalid = (val) => !val || val === "undefined" || val === "null";

  if (isInvalid(credentials.clientId)) {
    missing.push("ROBLOX_CLIENT_ID");
    errors.push("Missing or invalid client_id: Roblox authorization cannot proceed without a valid client ID.");
  }

  if (isInvalid(credentials.clientSecret)) {
    missing.push("ROBLOX_CLIENT_SECRET");
    errors.push("Missing or invalid client_secret: Token exchange with Roblox will fail.");
  }

  if (isInvalid(credentials.redirectUri)) {
    missing.push("ROBLOX_REDIRECT_URI");
    errors.push("Missing or invalid redirect_uri: Roblox OAuth requires a registered callback URL.");
  } else {
    try {
      new URL(credentials.redirectUri);
    } catch {
      errors.push(`Invalid redirect_uri format: "${credentials.redirectUri}" is not a valid URL.`);
    }
  }

  return {
    ok: missing.length === 0 && errors.length === 0,
    hasClientId: !isInvalid(credentials.clientId),
    hasClientSecret: !isInvalid(credentials.clientSecret),
    hasRedirectUri: !isInvalid(credentials.redirectUri),
    clientId: credentials.clientId,
    redirectUri: credentials.redirectUri,
    missing,
    errors,
  };
}

/**
 * Reports configuration status at startup. Logs clear errors if the client ID or
 * other required parameters are missing, WITHOUT printing any secrets.
 */
export function checkRobloxOAuthConfigAtStartup(env = process.env, logger = console) {
  const validation = validateRobloxOAuthConfig(env);

  if (!validation.hasClientId) {
    logger.error(
      "[PTB Roblox OAuth Configuration Error] ROBLOX_CLIENT_ID is missing or empty! " +
      "Generating authorization URLs will fail or trigger 'Authorization Error — RouterParamMissingOrInvalid: client_id' on Roblox. " +
      "Please set ROBLOX_CLIENT_ID in your environment or .env file with your OAuth 2.0 app Client ID from the Roblox Creator Dashboard."
    );
  }

  if (!validation.hasClientSecret) {
    logger.error(
      "[PTB Roblox OAuth Configuration Error] ROBLOX_CLIENT_SECRET is missing or empty! " +
      "OAuth token exchange after user authorization will fail. Please set ROBLOX_CLIENT_SECRET in your environment or .env file."
    );
  }

  if (!validation.hasRedirectUri) {
    logger.warn(
      "[PTB Roblox OAuth Configuration Warning] ROBLOX_REDIRECT_URI is not set. Defaulting to: " + validation.redirectUri
    );
  }

  if (validation.ok) {
    // Mask the client ID so only first and last few digits appear; NEVER log the secret!
    const maskedId = validation.clientId.length > 8
      ? `${validation.clientId.slice(0, 4)}...${validation.clientId.slice(-4)}`
      : "***";
    logger.log(
      `[PTB Roblox OAuth] Configured and ready. Client ID: ${maskedId}, Redirect URI: ${validation.redirectUri}`
    );
  }

  return validation.ok;
}

/**
 * Builds the Roblox OAuth 2.0 authorization URL with all required PKCE and OIDC parameters.
 * Throws a descriptive error if client_id is missing, empty, or invalid.
 */
export function buildRobloxAuthorizationUrl({
  clientId,
  redirectUri,
  state,
  codeChallenge,
  scopes = "openid profile",
}) {
  const sanitizedClientId = sanitizeOAuthValue(clientId);
  const sanitizedRedirectUri = sanitizeOAuthValue(redirectUri);

  if (!sanitizedClientId || sanitizedClientId === "undefined" || sanitizedClientId === "null") {
    throw new Error(
      "Roblox OAuth client_id is missing or invalid. A non-empty, valid client_id is required to generate the authorization URL."
    );
  }

  if (!sanitizedRedirectUri) {
    throw new Error("Roblox OAuth redirect_uri is missing or empty.");
  }

  try {
    new URL(sanitizedRedirectUri);
  } catch {
    throw new Error(`Roblox OAuth redirect_uri "${sanitizedRedirectUri}" is not a valid URL.`);
  }

  if (!state || typeof state !== "string" || !state.trim()) {
    throw new Error("Roblox OAuth state parameter is required for CSRF protection.");
  }

  if (!codeChallenge || typeof codeChallenge !== "string" || !codeChallenge.trim()) {
    throw new Error("Roblox OAuth code_challenge parameter is required for PKCE.");
  }

  const authorizeUrl = new URL("https://apis.roblox.com/oauth/v1/authorize");
  authorizeUrl.search = new URLSearchParams({
    client_id: sanitizedClientId,
    redirect_uri: sanitizedRedirectUri,
    scope: scopes,
    response_type: "code",
    state: String(state).trim(),
    code_challenge: String(codeChallenge).trim(),
    code_challenge_method: "S256",
  }).toString();

  return authorizeUrl.toString();
}

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
export function buildTokenRequestBody(code, codeVerifier, redirectUri, clientId, clientSecret) {
  const credentials = getRobloxOAuthCredentials();
  const effectiveClientId = sanitizeOAuthValue(clientId || credentials.clientId);
  const effectiveClientSecret = sanitizeOAuthValue(clientSecret || credentials.clientSecret);

  if (!effectiveClientId) {
    throw new Error("client_id is required for Roblox OAuth token request.");
  }

  return new URLSearchParams({
    client_id: effectiveClientId,
    client_secret: effectiveClientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
}

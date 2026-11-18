/**
 * Accounts Google refused with a verification challenge (HTTP 403, "Verify your
 * account to continue."), in memory, by email.
 *
 * Not a rest and not quota: it blocks nothing. Whether the challenge is
 * per-account or per-project is not known, so routing keeps trying the account
 * rather than stranding a pool that may hold only one. The flag exists so the
 * dashboard can name the account to re-login. It clears when that account
 * answers again, is re-logged in, or is removed from the pool; a restart forgets
 * it, and the next challenge re-flags it. Only a 403 that actually asks for
 * verification raises it (see isVerificationChallenge).
 */
const flagged = new Set<string>();

/** Google refused this account and asked for verification. */
export function flagVerification(email: string | undefined): void {
  if (email) flagged.add(email.toLowerCase());
}

/** The account answered, or was re-logged in: the challenge no longer applies. */
export function clearVerification(email: string | undefined): void {
  if (email) flagged.delete(email.toLowerCase());
}

/** Whether the dashboard should tell the operator to re-login this account. */
export function isVerificationFlagged(email: string | undefined): boolean {
  return email ? flagged.has(email.toLowerCase()) : false;
}

/** Google's own words for the challenge. A 403 can also be plain permission denial. */
const VERIFICATION_CHALLENGE = /verify your account/i;

/**
 * Whether a 403 message is the verification challenge rather than another refusal.
 * The badge and the client guidance both claim verification, so they may only appear
 * when Google actually asked for it: telling the operator to verify something Google
 * never asked for would be a lie about the account's state.
 */
export function isVerificationChallenge(message: string): boolean {
  return VERIFICATION_CHALLENGE.test(message);
}

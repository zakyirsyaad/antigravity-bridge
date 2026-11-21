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

/**
 * Accounts Google has disabled outright (HTTP 403, "This service has been disabled in this
 * account for violation of Terms of Service. Please submit an appeal..."). Its own state: no
 * login clears it, only Google's appeal, so the card must not offer Re-login as the cure.
 */
const disabled = new Set<string>();

/** Google answered that it has disabled this account. */
export function flagDisabled(email: string | undefined): void {
  if (email) disabled.add(email.toLowerCase());
}

/** Whether Google last answered this account as disabled. */
export function isAccountDisabled(email: string | undefined): boolean {
  return email ? disabled.has(email.toLowerCase()) : false;
}

/**
 * Whether the pool should pass this account over while another is free: Google wants it
 * verified, or has disabled it. Any other 403 raises neither sign and is not skipped.
 */
export function isAccountRefused(email: string | undefined): boolean {
  return isVerificationFlagged(email) || isAccountDisabled(email);
}

/** The account answered, was re-logged in or was removed: neither sign applies any more. */
export function clearVerification(email: string | undefined): void {
  if (!email) return;
  flagged.delete(email.toLowerCase());
  disabled.delete(email.toLowerCase());
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

/** Google's own words for an account it has disabled. */
const DISABLED_NOTICE = /has been disabled in this account|violation of terms of service/i;

/** Whether a 403 message says Google disabled the account, rather than challenging it. */
export function isDisabledNotice(message: string): boolean {
  return DISABLED_NOTICE.test(message);
}

/** Raise the sign a 403's message earns, if any. */
export function flagRefusal(email: string | undefined, message: string): void {
  if (isVerificationChallenge(message)) flagVerification(email);
  else if (isDisabledNotice(message)) flagDisabled(email);
}

/** What the operator can do about a 403, by what Google said. Never claims more than it said. */
export function refusalRecovery(message: string): string {
  if (isVerificationChallenge(message)) {
    return "Open the bridge dashboard and click Re-login on that account, then complete Google's verification prompt in the browser tab that opens. No terminal needed.";
  }
  if (isDisabledNotice(message)) {
    return "Google has disabled that account, and signing in again will not restore it: submit Google's appeal for it, and remove it from the pool in the bridge dashboard meanwhile.";
  }
  return "Open the bridge dashboard and re-login that account, or check its access to this model. No terminal needed.";
}

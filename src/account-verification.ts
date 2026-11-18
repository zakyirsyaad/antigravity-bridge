/**
 * Accounts Google refused with a verification challenge (HTTP 403, "Verify your
 * account to continue."), in memory, by email.
 *
 * Not a rest and not quota: it blocks nothing. Whether the challenge is
 * per-account or per-project is not known, so routing keeps trying the account
 * rather than stranding a pool that may hold only one. The flag exists so the
 * dashboard can name the account to re-login. It clears when that account
 * answers again or is re-logged in; a restart forgets it, and the next 403
 * re-flags it.
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
  return Boolean(email) && flagged.has((email as string).toLowerCase());
}

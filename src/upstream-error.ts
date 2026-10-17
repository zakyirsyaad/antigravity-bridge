/**
 * An HTTP error answered by Google, with the status kept as data.
 *
 * It used to exist only inside the message ("... (400): ..."), so deciding what
 * to do about a failure meant searching a string for a number. The message text
 * is unchanged, so the checks that still do that keep working.
 *
 * Its own module so that `pool-failures.ts` can build one without importing the
 * client that imports it; `antigravity-client.ts` re-exports it.
 */
export class UpstreamError extends Error {
  public readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

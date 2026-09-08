/**
 * `catch (err)` binds `unknown` under `strict`. Matches the behaviour of the
 * `String(err?.message || err)` this replaced, for every realistic input.
 */
export const errMessage = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

// R3-03: login and register put an error that belongs to one field under that field (U11: debt
// border, aria-invalid, message below — Field does all three) and keep the banner at the top for
// whole-form errors only (wrong credentials, rate limit, Google sign-in, network).

export type AuthField = "name" | "username" | "password";

/** Field-level messages as `Auth` translation keys. */
export type AuthFieldKeys = Partial<Record<AuthField, string>>;

const FIELD_BY_CODE: Record<string, AuthField> = {
  INVALID_NAME: "name",
  MISSING_USERNAME: "username",
  INVALID_USERNAME: "username",
  USERNAME_TAKEN: "username",
  INVALID_PASSWORD: "password",
  PASSWORD_TOO_COMMON: "password",
  PASSWORD_NO_COMPLEXITY: "password",
};

/** The field an API error code belongs to; null = the whole form (banner). */
export function authErrorField(code: string | undefined): AuthField | null {
  return code && Object.hasOwn(FIELD_BY_CODE, code) ? FIELD_BY_CODE[code] : null;
}

/** Checks before POST /api/auth/login: every empty field is required. */
export function validateLogin(v: { username: string; password: string }): AuthFieldKeys {
  const errors: AuthFieldKeys = {};
  if (!v.username.trim()) errors.username = "fieldRequired";
  if (!v.password) errors.password = "fieldRequired";
  return errors;
}

/** Checks before POST /api/auth/register — empty first, then the field's own rule. The rule's
 *  message is the field's hint, shown in red in its place (Field renders the error instead of the
 *  hint), so it is no longer repeated in a banner. */
export function validateRegister(v: { name: string; username: string; password: string }): AuthFieldKeys {
  const errors: AuthFieldKeys = {};
  if (!v.name.trim()) errors.name = "fieldRequired";
  if (!v.username.trim()) errors.username = "fieldRequired";
  else if (v.username.trim().length < 3) errors.username = "usernameHint";
  if (!v.password) errors.password = "fieldRequired";
  else if (v.password.length < 8) errors.password = "passwordHint";
  return errors;
}

/** The first field, in form order, that has an error — it receives focus. */
export function firstErrorField(
  order: readonly AuthField[],
  errors: Partial<Record<AuthField, unknown>>
): AuthField | null {
  return order.find((f) => errors[f] !== undefined) ?? null;
}

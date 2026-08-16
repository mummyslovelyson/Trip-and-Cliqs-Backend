/**
 * Shared password policy for Tribes & Cliqs.
 *
 * Used by registration, password reset and change-password flows so the
 * whole platform enforces one consistent rule set.
 */

export const PASSWORD_RULES = {
  minLength: 8,
  // At least one letter AND one digit keeps weak passwords like "aaaaaaa"
  // out while staying friendly enough for real users.
  requireLetter: true,
  requireNumber: true,
};

/**
 * Validate a candidate password against the shared policy.
 * @param {string} password
 * @returns {{ valid: boolean, message?: string }}
 */
export const validatePassword = (password) => {
  if (typeof password !== 'string' || password.length === 0) {
    return { valid: false, message: 'Password is required' };
  }
  if (password.length < PASSWORD_RULES.minLength) {
    return { valid: false, message: `Password must be at least ${PASSWORD_RULES.minLength} characters` };
  }
  if (PASSWORD_RULES.requireLetter && !/[a-zA-Z]/.test(password)) {
    return { valid: false, message: 'Password must contain at least one letter' };
  }
  if (PASSWORD_RULES.requireNumber && !/\d/.test(password)) {
    return { valid: false, message: 'Password must contain at least one number' };
  }
  return { valid: true };
};

/**
 * Human-readable summary of the policy (used in UI hints).
 */
export const PASSWORD_HINT = `At least ${PASSWORD_RULES.minLength} characters with a mix of letters and numbers.`;

export default validatePassword;

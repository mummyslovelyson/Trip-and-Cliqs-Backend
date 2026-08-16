import { validationResult } from 'express-validator';

/**
 * Run an express-validator rule chain and fail the request on the first
 * validation error. Errors are formatted as `{ message }` to match the
 * shape the frontend already expects from the rest of the API.
 *
 * Usage:
 *   router.post('/login', validate([
 *     body('email').isEmail().withMessage('Invalid email address'),
 *   ]), login);
 */
export const validate = (rules) => [
  rules,
  (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ message: errors.array()[0].msg });
    }
    next();
  },
];

export default validate;

import type { Role } from './types.js';

/** A role's own allowance is exhausted; it cannot consume navigation's money. */
export class RoleAllowanceLimit extends Error {
  constructor(
    public role: Role,
    message: string,
  ) {
    super(message);
  }
}

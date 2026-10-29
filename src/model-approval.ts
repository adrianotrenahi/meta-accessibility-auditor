import type { Approval } from './types.js';

const message = 'A current bounded owner approval is required before preparing any model request.';

/** Only the initial allowance check may produce this error. It runs before
 * input counting, a reservation or a provider request. Later failures stay uncertain.
 */
export class ModelApprovalRequiredError extends Error {
  constructor(options?: ErrorOptions) {
    super(message, options);
    this.name = 'ModelApprovalRequiredError';
  }
}

export function requireCurrentModelApproval(read: () => Approval): Approval {
  let approved: Approval;
  try {
    approved = read();
  } catch (cause) {
    throw new ModelApprovalRequiredError({ cause });
  }
  if (
    !approved ||
    typeof approved !== 'object' ||
    Array.isArray(approved) ||
    approved.approvedBy !== 'Adriano' ||
    !Number.isFinite(Date.parse(approved.expiresAt)) ||
    Date.parse(approved.expiresAt) <= Date.now() ||
    !Number.isFinite(approved.maxUsd) ||
    approved.maxUsd <= 0 ||
    approved.maxUsd > 110 ||
    !Number.isFinite(approved.maxRunUsd) ||
    approved.maxRunUsd <= 0 ||
    approved.maxRunUsd > 3
  )
    throw new ModelApprovalRequiredError();
  return approved;
}

export function modelApprovalDenial(error: unknown) {
  if (!(error instanceof ModelApprovalRequiredError)) return null;
  return {
    status: 403,
    body: {
      error: message,
      code: 'LOCAL_MODEL_APPROVAL_REQUIRED',
      stage: 'before-provider',
    },
  } as const;
}

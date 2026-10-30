const ALLOWANCE_MESSAGE = 'Planning needs an active local test spending allowance. This attempt stopped before contacting Meta, and your saved setup is kept. Once an allowance is active, retry this same setup.';

class LocalPlanApprovalFailure extends Error {
  constructor() {
    super(ALLOWANCE_MESSAGE);
    this.name = 'LocalPlanApprovalFailure';
  }
}

/** Only a typed refusal from the owned local planner is known to precede a
 * provider call. Network errors, arbitrary words and other routes prove none. */
export function planApprovalFailure(route, method, status, reply) {
  if (route !== '/api/host/journey-plans' || method !== 'POST' || status !== 403 ||
    !reply || typeof reply !== 'object' || Array.isArray(reply) ||
    typeof reply.error !== 'string' || reply.code !== 'LOCAL_MODEL_APPROVAL_REQUIRED' ||
    reply.stage !== 'before-provider') return null;
  return new LocalPlanApprovalFailure();
}

export function isPlanApprovalFailure(error) {
  return error instanceof LocalPlanApprovalFailure;
}

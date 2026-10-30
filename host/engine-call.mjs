import { planApprovalFailure } from "./plan-failures.mjs";

/** The owned local engine call used by the Meta funnel, including error decoding. */
export function createMetaEngineCall(origin, token) {
  return async (route, method = "GET", body, timeoutMs = 15000) => {
    const response = await fetch(origin + route, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "x-session-token": token,
        "Content-Type": "application/json",
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const error = await response.json();
      const denied = planApprovalFailure(route, method, response.status, error);
      if (denied) throw denied;
      throw Error(error.error || "The local engine refused this action.");
    }
    return response;
  };
}

/** The exact planning request used by the existing setup; no browser action. */
export function createJourneyPlanPreparer(call) {
  return async (draft) => (await (await call("/api/host/journey-plans", "POST", draft, 65000)).json());
}

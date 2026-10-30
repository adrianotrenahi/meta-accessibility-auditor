// New local engine connection only; ordinary Cavioo dispatch remains unchanged.
export function configuredPublicWebsites(manifest, enabled = false) {
  if (typeof enabled !== "boolean" || (manifest.capabilities?.publicWebsites === true) !== enabled ||
    (enabled && manifest.mode !== "live"))
    throw Error("The engine did not confirm public website mode.");
  return enabled;
}
export function publicBrief(body, requireJourney = false) {
  if (typeof body?.url !== "string" || body.url.length > 2048)
    throw Error("Enter the website address.");
  const url = new URL(body.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw Error("Enter a public HTTP or HTTPS website without credentials in its address.");
  if (body.journey !== undefined && (typeof body.journey !== "string" || body.journey.length > 1500))
    throw Error("Keep the journey within 1,500 characters.");
  const goal = body.journey?.trim() ?? "";
  if (requireJourney && !goal) throw Error("Describe the journey to test.");
  return { url: url.href, goal };
}
/** A public proposal must contain actual structured planner steps. */
export function publicPlanSteps(steps) {
  const checked = checkedPublicSteps(steps);
  if (checked.length < 2)
    throw Error("The Meta planner must break the journey into at least two instructions.");
  if (checked.some((step) => !step.intent || !step.success?.trim()))
    throw Error("The Meta planner did not supply a complete journey plan.");
  // Keep the actual proposed values; user edits are approved separately later.
  return structuredClone(steps);
}
function checkedPublicSteps(steps) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 12)
    throw Error("The journey has an unsupported number of steps.");
  const stepKeys = ["id", "text", "intent", "success", "hint", "optional"];
  for (const step of steps) {
    if (!step || typeof step.id !== "string" || !step.id || step.id.length > 80 ||
      typeof step.text !== "string" || !step.text.trim() || step.text.length > 500 ||
      (step.intent !== undefined && !["navigate", "search", "form", "explore", "verify", "complete"].includes(step.intent)) ||
      ["success", "hint"].some(k => step[k] !== undefined && (typeof step[k] !== "string" || step[k].length > 500)) ||
      (step.optional !== undefined && typeof step.optional !== "boolean") ||
      Object.keys(step).some(k => !stepKeys.includes(k))) throw Error("The journey has an unsupported step.");
  }
  if (new Set(steps.map(s => s.id)).size !== steps.length) throw Error("Journey step identities must be unique.");
  return steps.map(s => Object.fromEntries(stepKeys.filter(k => s[k] !== undefined).map(k => [k, k === 'text' ? s[k].trim() : s[k]])));
}
/** The one local account (see TESTING_ACCOUNT in funnel-server.mjs). */
export const LOCAL_ACCOUNT_ID = "testing-account";
export function publicPlan(body, devices) {
  const plan = body?.plan;
  const brief = publicBrief({ url: body?.url, journey: plan?.journey }, true);
  if (body.acceptedUsePolicy !== true || body.accountId !== LOCAL_ACCOUNT_ID ||
    !plan || new URL(plan.url).href !== brief.url || plan.maskSensitiveData !== false ||
    plan.keyboardJourney !== true || JSON.stringify(plan.devices) !== JSON.stringify(devices) ||
    !Array.isArray(plan.features) || plan.features.length !== 0 ||
    !/^[a-f0-9-]{36}$/i.test(plan.draftId ?? "") ||
    !Array.isArray(plan.steps) || plan.steps.length < 1 || plan.steps.length > 12)
    throw Error("Use the Desktop keyboard plan for this local website run.");
  const allowedBody = ["url", "plan", "acceptedUsePolicy", "accountId"];
  const allowedPlan = ["url", "journey", "draftId", "steps", "devices", "features", "accountIntent", "maskSensitiveData", "keyboardJourney"];
  if (Object.keys(body).some(k => !allowedBody.includes(k)) || Object.keys(plan).some(k => !allowedPlan.includes(k)))
    throw Error("Unsupported website run settings.");
  return { ...brief, steps: checkedPublicSteps(plan.steps) };
}

export function validateSavedPublicTarget(job) {
  if (job.deleted) {
    if (job.target || job.briefHash) throw Error("Discarded website details remain in the saved record.");
    return;
  }
  const target = job.target;
  if (!target || typeof target !== "object" || Object.keys(target).sort().join(",") !== "goal,steps,url")
    throw Error("The saved website and journey are missing.");
  return publicPlan({ url: target.url, acceptedUsePolicy: true, accountId: LOCAL_ACCOUNT_ID,
    plan: { url: target.url, journey: target.goal, steps: target.steps, draftId: job.draftId,
      devices: ["desktop_1440_900"], features: [], keyboardJourney: true, maskSensitiveData: false }
  }, ["desktop_1440_900"]);
}

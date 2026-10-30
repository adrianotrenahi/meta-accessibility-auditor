import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadCaviooUi } from "./cavioo-ui.mjs";
import { configuredPublicWebsites, LOCAL_ACCOUNT_ID, publicBrief, publicPlan, validateSavedPublicTarget } from "./public-websites.mjs";
import { openJourneyDrafts, checkedJourneyPlanReference } from "./journey-drafts.mjs";
import { recoverUnstartedJourneyJob, confirmJourneyJobDiscard } from "./journey-job-cleanup.mjs";
import { createMetaEngineCall, createJourneyPlanPreparer } from "./engine-call.mjs";
const uuid = /^[a-f0-9-]{36}$/;
const digest = (value) => createHash("sha256").update(value).digest("hex");
/** The one local user. Audits belong to the account, not to a browser, so every
 * browser on this computer sees the same audits, and no other account's. */
export const TESTING_ACCOUNT = Object.freeze({ id: LOCAL_ACCOUNT_ID, name: "Testing Account" });
const ACCOUNT_OWNER = digest(`access-walk/account/${TESTING_ACCOUNT.id}`);
// Records saved before accounts were filed under a browser tag. This page only
// ever had one account, so they are that account's; their tag stays unchanged
// because saved plans and drafts are bound to it.
export const inAccount = (job) => job.account === TESTING_ACCOUNT.id || job.account === undefined;
/** Startup configuration chooses the mode; a browser request never can. */
export function configuredProofMode(manifest, controlledLiveProof = false) {
  if (typeof controlledLiveProof !== "boolean")
    throw Error("The controlled live proof must be explicitly enabled.");
  const mode = controlledLiveProof ? "live" : "offline";
  if (
    manifest.protocol !== "access-walk/host-v1" ||
    manifest.mode !== mode ||
    manifest.capabilities?.manualCheckpoints !== !controlledLiveProof
  )
    throw Error("The local engine did not confirm the configured proof mode.");
  return mode;
}
export async function startMetaFunnelProof({
  engineRoot,
  dataDirectory,
  port = 4346,
  engineNode = process.execPath,
  controlledLiveProof = false,
  publicWebsites = false,
  /** Where the engine reads its .env and spend-approval.json; a private runtime folder by default. */
  engineWorkingDirectory,
}) {
  if (typeof controlledLiveProof !== "boolean" || typeof publicWebsites !== "boolean")
    throw Error("The controlled live proof must be explicitly enabled.");
  const directory = path.resolve(dataDirectory),
    engine = path.resolve(engineRoot);
  if (
    Number(
      execFileSync(engineNode, ["--version"], { encoding: "utf8" }).match(
        /^v(\d+)/,
      )?.[1],
    ) < 24
  )
    throw Error(
      "The public engine requires Node 24 or newer. Pass --engine-node with that executable.",
    );
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const runtime = path.join(directory, "runtime");
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const env = Object.fromEntries(
    ["PATH", "HOME", "USER", "TMPDIR", "LANG", "PLAYWRIGHT_BROWSERS_PATH"]
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]]),
  );
  const child = spawn(
    engineNode,
    [
      "--import",
      pathToFileURL(path.join(engine, "node_modules/tsx/dist/loader.mjs")).href,
      path.join(engine, "scripts/serve-host.ts"),
      "--data",
      path.join(directory, "engine"),
      ...(publicWebsites ? ["--public-websites"] : controlledLiveProof ? ["--controlled-live-proof"] : []),
    ],
    { cwd: engineWorkingDirectory ? path.resolve(engineWorkingDirectory) : runtime, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let childError = "";
  const childExited = new Promise((resolve) => child.once("exit", resolve));
  child.stderr.on("data", (chunk) => {
    childError = (childError + chunk).slice(-2000);
  });
  const origin = await new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("The local engine did not become ready."));
    }, 20000);
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(
        Error("The local engine stopped before becoming ready: " + childError),
      );
    });
    child.stdout.on("data", (chunk) => {
      out += chunk;
      for (const line of out.split("\n")) {
        try {
          const x = JSON.parse(line);
          if (
            x.protocol === "access-walk/host-v1" &&
            /^http:\/\/127\.0\.0\.1:\d+$/.test(x.origin)
          ) {
            clearTimeout(timer);
            resolve(x.origin);
          }
        } catch {
          /* A partial startup line is not a ready message. */
        }
      }
    });
  });
  const stopEngine = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await childExited;
  };
  try {
    const token = (await (await fetch(origin + "/api/session")).json()).token;
    const call = createMetaEngineCall(origin, token);
    const manifest = await (await call("/api/host")).json();
    const mode = configuredProofMode(manifest, controlledLiveProof || publicWebsites);
    const publicSites = configuredPublicWebsites(manifest, publicWebsites);
    // Cavioo's screens and the hackathon helpers arrive as one verified package.
    const ui = await loadCaviooUi({ cacheDirectory: path.join(directory, "cavioo-ui") });
    const {
      hostSnapshotSchema,
      projectMetaWalk,
      readMetaHistory,
      metaJourneyProgress,
      metaThoughtDelta,
      metaLiveFrameSchema,
      readOptionalMetaKeyboardEvidence,
      readOptionalMetaAssessment,
      META_ASSESSMENT_UNAVAILABLE,
    } = await import(`data:text/javascript;base64,${ui.hostLib}`);
    const files = ui.files;
    const records = path.join(directory, "jobs.json");
    let jobs = new Map();
    try {
      const rows = JSON.parse(await readFile(records, "utf8"));
      for (const job of rows) {
        if (
          !uuid.test(job.id) ||
          (job.engineId !== null && !uuid.test(job.engineId)) ||
          !/^[a-f0-9]{64}$/.test(job.owner)
        )
          throw Error("Invalid local proof record");
        if (publicSites) {
          if (job.journeyPlan) checkedJourneyPlanReference(job.journeyPlan, job.owner);
          const target = validateSavedPublicTarget(job);
          if (target && job.briefHash !== digest(JSON.stringify(target)))
            throw Error("The saved website, journey or plan has changed.");
        }
        if (!publicSites && job.target)
          throw Error("Saved public website runs cannot be reopened as controlled demonstrations.");
        jobs.set(job.id, job);
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        await stopEngine();
        throw error;
      }
    }
    let writes = Promise.resolve();
    // Pending removals affect disk writes, not the published in-memory state.
    // No read may report deletion complete until a cleared record is durable.
    const pendingRemovalWrites = new Map();
    const persist = () => {
      const next = writes
        .catch(() => {})
        .then(async () => {
          await writeFile(
            records + ".tmp",
            JSON.stringify([...jobs.values()].map((job) => pendingRemovalWrites.get(job.id) ?? job)),
            { mode: 0o600 },
          );
          await rename(records + ".tmp", records);
        });
      writes = next;
      return next;
    };
    const journeyDrafts = publicSites ? await openJourneyDrafts(
      path.join(directory, "drafts.json"),
      createJourneyPlanPreparer(call),
    ) : null;
    // An uncertain Start still owns its original approved instructions. It is
    // recoverable, not a used plan offered for another new generation.
    const usedDraftIds = () => new Set([...jobs.values()].filter((job) =>
      job.engineId !== null || job.deleted || job.discarding,
    ).map((job) => job.journeyPlan?.draftId).filter(Boolean));
    const boundJob = (owner, draftId, reference) => [...jobs.values()].find((job) =>
      job.owner === owner && (job.draftId.toLowerCase() === draftId.toLowerCase() ||
        (reference && job.journeyPlan?.draftId === reference.draftId)),
    );
    const pendingStart = (job, includeDiscarding = false) => publicSites && job.engineId === null && job.journeyPlan &&
      !job.deleted && (includeDiscarding || !job.discarding) ? { url: job.target.url, goal: job.target.goal,
        steps: job.target.steps } : undefined;
    const startSavedJob = async (job) => {
      if (job.deleted || job.discarding) throw Error("This saved Start was discarded.");
      if (job.engineId === null) {
        const started = await (await call("/api/host/runs", "POST", {
          mode, requestId: job.id,
          ...(publicSites ? { target: job.target,
            journeyPlan: checkedJourneyPlanReference(job.journeyPlan, job.owner) } : {}),
        })).json();
        if (!uuid.test(started.id)) throw Error("The saved Start reply could not be verified. Retry this same saved request.");
        job.engineId = started.id;
        if (job.deleted || job.discarding) {
          await call(`/api/host/requests/${job.id}/discard`, "POST", {});
          throw Error("This proof was discarded while starting.");
        }
      }
      await persist();
    };
    const uiPlan = (brief, draftId, prepared) => ({
      url: brief.url, journey: brief.goal, draftId, steps: prepared.steps,
      devices: manifest.devices, features: [], maskSensitiveData: false,
    });
    for (const job of jobs.values())
      if (job.engineId === null && !job.deleted) {
        const found = await (await call(`/api/host/requests/${job.id}`)).json();
        await recoverUnstartedJourneyJob(job, found, call);
        await persist();
      }
    const planSteps = [
      {
        id: "open",
        text: "Open the controlled shop",
        intent: "navigate",
        success: "The recorded product page is visible.",
      },
      {
        id: "basket",
        text: "Add the canvas bag and open the basket",
        intent: "verify",
        success: "The basket page is visible; no order is placed.",
      },
    ];
    const validateBrief = (body) => {
      if (publicSites) return publicBrief(body);
      if (
        body.url !== manifest.url ||
        (body.journey?.trim() && body.journey.trim() !== manifest.goal)
      )
        throw Error(
          "This local proof supports only its displayed controlled shop and journey. No other website will be visited.",
        );
    };
    const validatePlan = (body) => {
      if (publicSites) return publicPlan(body, manifest.devices);
      validateBrief(body);
      const plan = body.plan;
      if (
        body.acceptedUsePolicy !== true ||
        body.accountId !== TESTING_ACCOUNT.id ||
        !plan ||
        plan.url !== manifest.url ||
        plan.journey !== manifest.goal ||
        plan.maskSensitiveData !== false ||
        plan.keyboardJourney !== true ||
        JSON.stringify(plan.devices) !== JSON.stringify(manifest.devices) ||
        plan.features?.length !== 0 ||
        JSON.stringify(plan.steps) !== JSON.stringify(planSteps) ||
        typeof plan.draftId !== "string" ||
        !uuid.test(plan.draftId)
      )
        throw Error(
          "The local proof supports only the displayed Desktop keyboard plan. Restore that plan before starting.",
        );
      if (
        Object.keys(body).some(
          (key) =>
            !["url", "plan", "acceptedUsePolicy", "accountId"].includes(key),
        ) ||
        Object.keys(plan).some(
          (key) =>
            ![
              "url",
              "journey",
              "draftId",
              "steps",
              "devices",
              "features",
              "accountIntent",
              "maskSensitiveData",
              "keyboardJourney",
            ].includes(key),
        )
      )
        throw Error("Unsupported offline proof settings.");
    };
    const data = async (job) => {
      if (job.deleted || job.discarding || job.engineId === null) return null;
      // Return core records before the browser's 6s timeout, even if the optional read stalls.
      const optionalDeadline = performance.now() + 5000;
      const value = await (await call(`/api/host/runs/${job.engineId}`)).json();
      if (job.deleted || job.discarding) return null;
      value.snapshot = hostSnapshotSchema.parse(value.snapshot);
      if (value.snapshot.run.mode !== mode)
        throw Error("The saved run belongs to a different proof mode.");
      const optional = readOptionalMetaKeyboardEvidence(value.keyboard, value.snapshot);
      value.keyboard = optional.keyboard;
      value.keyboardWarning = optional.warning;
      // The journal sequence belongs to this optional assessment, not hostRevision.
      try {
        const remaining = Math.min(
          1000,
          Math.floor(optionalDeadline - performance.now()),
        );
        if (remaining <= 0)
          throw Error("The optional assessment read has no remaining time budget.");
        const assessed = await (
          await call(
            `/api/host/runs/${job.engineId}/assessment`,
            "GET",
            undefined,
            remaining,
          )
        ).json();
        const optionalAssessment = readOptionalMetaAssessment(assessed, value.snapshot);
        value.assessment = optionalAssessment.assessment;
        value.assessmentWarning = optionalAssessment.warning;
      } catch {
        value.assessment = undefined;
        value.assessmentWarning = META_ASSESSMENT_UNAVAILABLE;
      }
      if (job.deleted || job.discarding) return null;
      return value;
    };
    const jobView = (job, value) => {
      if (!value)
        return {
          status: job.deleted ? "done" : job.discarding ? "running" : "error",
          auditSessionId: null,
          progress: job.deleted
            ? { cancelled: true }
            : { phase: "saving", currentStep: 0, totalSteps: job.target?.steps.length ?? 0,
              message: job.discarding ? "Discarding the local proof…" : "Start is not confirmed. The original request is retained." },
          error: job.deleted || job.discarding ? null : "Start is not confirmed here. The engine may already have received it. Retry this exact saved request or discard it; its original instructions and charges remain retained.",
          startedAt: job.createdAt,
          workerOnline: true,
          deletedScreens: [],
          keyboardJourney: true,
        };
      const { snapshot } = value,
        view = projectMetaWalk(snapshot, {
          sessionId: job.id,
          evidenceBase: `/api/offline/jobs/${job.id}/assets`,
        });
      const ended = snapshot.run.state !== "running",
        interrupted = snapshot.run.state === "interrupted";
      const journey = metaJourneyProgress(snapshot.journey, job.target?.steps);
      return {
        status: ended ? (interrupted ? "error" : "done") : "running",
        auditSessionId: ended && !interrupted ? job.id : null,
        error: interrupted ? snapshot.run.stopReason : null,
        startedAt: job.createdAt,
        targetUrl: snapshot.run.url,
        workerOnline: true,
        runInterrupted: interrupted,
        deletedScreens: [],
        platform: null,
        keyboardJourney: true,
        progress: {
          ...view.progress,
          phase: ended ? "done" : "capturing",
          message: ended
            ? snapshot.run.stopReason
            : mode === "live"
              ? publicSites ? "Meta website run · reviewed findings only" : "Controlled Meta live run · reviewed findings only"
              : "Controlled local keyboard run · saved analysis responses",
          currentStep: journey?.currentStep ?? (job.journeyPlan ? 0 : publicSites ? 1 : Math.max(1, Math.min(2, view.steps.length > 5 ? 2 : 1))),
          totalSteps: job.target?.steps.length ?? 2,
          tasks: (job.target?.steps ?? planSteps).map((step, i) => ({
            i,
            type: "execute_step",
            pageUrl: snapshot.run.url,
            pageLabel: step.text,
            stepId: step.id,
            stepText: step.text,
            stepSuccess: step.success,
            device: "desktop_1440_900",
            status: journey?.status(step.id) ?? (ended && mode === "offline" ? "done" : "pending"),
          })),
        },
      };
    };
    const discards = new Map();
    const discard = (job) => {
      if (job.deleted) return persist();
      if (discards.has(job.id)) return discards.get(job.id);
      job.discarding = true;
      job.discardError = null;
      const pending = (async () => {
        try {
          await persist();
          await confirmJourneyJobDiscard(job, call, journeyDrafts);
          const removed = { ...job, deleted: true, discarding: false, discardError: null };
          delete removed.target;
          delete removed.briefHash;
          pendingRemovalWrites.set(job.id, removed);
          await persist();
          job.deleted = true;
          job.discarding = false;
          job.discardError = null;
          delete job.target;
          delete job.briefHash;
          pendingRemovalWrites.delete(job.id);
        } catch (error) {
          job.discardError =
            "Discard has not finished. Retry to confirm removal of this run and its screenshots.";
          await persist();
          throw error;
        }
      })();
      discards.set(job.id, pending);
      pending.finally(() => discards.delete(job.id)).catch(() => {});
      return pending;
    };
    for (const job of jobs.values())
      if (job.discarding) await discard(job).catch(() => {});
    // Both existing list requests share only their in-flight read, never a
    // retained result. Reads do not start, resume, analyse or rewrite a run.
    const historyReads = new Map();
    const history = (owner) => {
      if (historyReads.has(owner)) return historyReads.get(owner);
      const pending = readMetaHistory(jobs.values(), inAccount, mode, async (id) =>
        (await (await call(`/api/host/runs/${id}`)).json()).snapshot,
      );
      historyReads.set(owner, pending);
      const clear = () => { if (historyReads.get(owner) === pending) historyReads.delete(owner); };
      pending.then(clear, clear);
      return pending;
    };
    let hostOrigin;
    const server = createServer(async (req, res) => {
      const json = (status, body) => {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(JSON.stringify(body));
      };
      try {
        if (
          req.headers.host !== new URL(hostOrigin).host ||
          (req.headers.origin && req.headers.origin !== hostOrigin) ||
          req.headers["sec-fetch-site"] === "cross-site"
        )
          return json(403, { error: "Open this local proof directly." });
        const url = new URL(req.url, hostOrigin),
          pathname = url.pathname;
        const cookie = req.headers.cookie?.match(
          /(?:^|;\s*)meta_offline=([a-f0-9]{64})(?:;|$)/,
        )?.[1];
        // The cookie only proves this browser opened the page; audits belong to the account.
        const owner = cookie ? ACCOUNT_OWNER : null;
        const html =
          req.method === "GET" &&
          (pathname === "/" ||
            pathname === "/audits" ||
            pathname === "/audits/new" ||
            /^\/audits\/(?:run\/)?[a-f0-9-]{36}$/.test(pathname));
        if (html) {
          if (!cookie)
            res.setHeader(
              "Set-Cookie",
              `meta_offline=${randomBytes(32).toString("hex")}; HttpOnly; SameSite=Strict; Path=/`,
            );
        }
        if (pathname.startsWith("/api/")) {
          if (!owner)
            return json(401, { error: "Open the local setup first." });
          let body = {};
          if (req.method === "POST") {
            let text = "";
            for await (const chunk of req) {
              text += chunk;
              if (text.length > 32768)
                return json(413, { error: "Request too large." });
            }
            body = text ? JSON.parse(text) : {};
          }
          if (req.method === "GET" && ["/api/sessions", "/api/captures"].includes(pathname)) {
            try {
              const saved = await history(owner);
              const warning = saved.unavailableCount
                ? `${saved.unavailableCount} saved run${saved.unavailableCount === 1 ? "" : "s"} could not be read and ${saved.unavailableCount === 1 ? "is" : "are"} not listed. Original records are retained. Reload to check again.`
                : null;
              return json(200, pathname === "/api/sessions"
                ? { sessions: saved.sessions, warning }
                : { captures: saved.captures });
            } catch {
              return json(503, { error: "The saved local audit history could not be read. Original records are retained." });
            }
          }
          if (req.method === "GET" && pathname === "/api/offline/pending-starts")
            return json(200, { pendingStarts: [...jobs.values()].filter(inAccount)
              .flatMap((job) => pendingStart(job, true) ? [{ jobId: job.id, ...pendingStart(job, true) }] : []) });
          if (req.method === "GET" && pathname === "/api/offline/bootstrap")
            return json(200, {
              ...manifest,
              account: TESTING_ACCOUNT.name,
            });
          if (req.method === "GET" && pathname === "/api/v1/accounts")
            return json(200, {
              accounts: [
                {
                  id: TESTING_ACCOUNT.id,
                  name: TESTING_ACCOUNT.name,
                  role: "OWNER",
                  home: true,
                  runsAudits: true,
                  active: true,
                },
              ],
            });
          if (req.method === "GET" && pathname === "/api/v1/me")
            return json(200, {
              user: {
                id: TESTING_ACCOUNT.id,
                name: TESTING_ACCOUNT.name,
                isAdmin: false,
              },
            });
          if (req.method === "GET" && pathname === "/api/v1/notifications")
            return json(200, { notifications: [], unread: 0 });
          if (req.method === "GET" && pathname === "/api/v1/billing/summary")
            return json(200, {
              accountId: TESTING_ACCOUNT.id,
              plan: "pro",
              synthetic: true,
            });
          if (req.method === "GET" && pathname === "/api/v1/autonomous/plans")
            return json(200, { plans: [] });
          if (
            req.method === "GET" &&
            pathname === "/api/v1/autonomous/plan/saved"
          ) {
            if (!publicSites) return json(200, { plan: null });
            const brief = publicBrief({ url: url.searchParams.get("url"), journey: url.searchParams.get("journey") }, true);
            const draftId = url.searchParams.get("draftId");
            const body = { url: brief.url, journey: brief.goal };
            const saved = await journeyDrafts.restore(owner, draftId, body, usedDraftIds());
            const reference = journeyDrafts.existingReference(owner, draftId, body);
            const prior = reference ? boundJob(owner, draftId, reference) : null;
            const original = prior && pendingStart(prior);
            return json(200, original ? uiPlan(brief, draftId, original)
              : saved ? uiPlan(brief, draftId, saved) : { plan: null });
          }
          if (
            req.method === "POST" &&
            pathname === "/api/v1/autonomous/reachability"
          ) {
            validateBrief(body);
            if (publicSites) {
              const checked = await (await call("/api/host/target-check", "POST", { url: body.url })).json();
              return json(200, { ...checked, blocked: [401, 403, 429].includes(checked.status), botProtected: null });
            }
            return json(200, {
              reachable: true,
              blocked: false,
              botProtected: false,
            });
          }
          if (
            req.method === "POST" &&
            pathname === "/api/v1/autonomous/features"
          ) {
            validateBrief(body);
            return json(200, { features: [] });
          }
          if (req.method === "POST" && pathname === "/api/v1/autonomous/plan") {
            validateBrief(body);
            if (body.features !== undefined && (!Array.isArray(body.features) || body.features.length))
              throw Error("Extra features are not available in this local Meta test.");
            if (publicSites) {
              if (Object.keys(body).some((key) => !["url", "journey", "features", "draftId"].includes(key)))
                throw Error("Unsupported journey planning settings.");
              const brief = publicBrief(body, true);
              const prepared = await journeyDrafts.prepare(owner, body.draftId, body, usedDraftIds());
              return json(200, uiPlan(brief, body.draftId, prepared));
            }
            return json(200, uiPlan({ url: manifest.url, goal: manifest.goal }, body.draftId, { steps: planSteps }));
          }
          if (
            req.method === "POST" &&
            pathname === "/api/v1/autonomous/audit"
          ) {
            const target = validatePlan(body);
            const briefHash = publicSites ? digest(JSON.stringify(target)) : undefined;
            const reference = publicSites ? journeyDrafts.existingReference(owner, body.plan.draftId,
              { url: target.url, journey: target.goal }) : null;
            const prior = publicSites ? boundJob(owner, body.plan.draftId, reference)
              : [...jobs.values()].find((job) => inAccount(job) && job.owner === owner && job.draftId === body.plan.draftId);
            if (prior) {
              if (prior.deleted || prior.discarding)
                return json(409, {
                  error:
                    "This proof was discarded. Open a new setup to start another.",
                });
              if (publicSites && prior.briefHash !== briefHash)
                return json(409, { error: "These instructions differ from the original saved Start and were not applied. Close this plan, then open the saved Start in the local notice to retry its original instructions or discard it." });
              if (publicSites && prior.engineId === null && !prior.journeyPlan)
                throw Error("This saved Start has no verified journey plan. Open a new setup.");
              await startSavedJob(prior);
              return json(200, { jobId: prior.id });
            }
            const journeyPlan = publicSites
              ? journeyDrafts.reference(owner, body.plan.draftId, { url: target.url, journey: target.goal }) : undefined;
            const job = {
              id: randomUUID(),
              engineId: null,
              owner,
              account: TESTING_ACCOUNT.id,
              draftId: body.plan.draftId,
              createdAt: new Date().toISOString(),
              deleted: false,
              discarding: false,
              ...(publicSites ? { target, briefHash, journeyPlan } : {}),
            };
            jobs.set(job.id, job);
            await persist();
            // The persisted request identity survives an uncertain response.
            await startSavedJob(job);
            return json(201, { jobId: job.id });
          }
          const resource = pathname.match(
            /^\/api\/(?:v1\/autonomous\/audit|offline\/jobs)\/([a-f0-9-]{36})(?:\/(live|advance|cancel|stop|assets|frame|retry)(?:\/([a-f0-9]{64})\.png)?)?$/,
          );
          if (resource) {
            const [, id, action, hash] = resource,
              job = jobs.get(id);
            if (!job || !inAccount(job))
              return json(404, { error: "Not found" });
            if (req.method === "POST" && action === "retry") {
              if (Object.keys(body).length || !pendingStart(job))
                throw Error("Only the exact unconfirmed saved Start can be retried here.");
              await startSavedJob(job);
              return json(200, { jobId: job.id });
            }
            if (req.method === "POST" && action === "cancel") {
              await discard(job);
              return json(200, { cancelled: true });
            }
            if (job.deleted || job.discarding) {
              if (req.method === "GET" && !action)
                return json(200, {
                  ...jobView(job, null),
                  jobId: job.id,
                  deleted: job.deleted,
                  discarding: job.discarding,
                  discardError: job.discardError,
                  ...(pendingStart(job, true) ? { pendingStart: pendingStart(job, true) } : {}),
                });
              return json(404, { error: "Not found" });
            }
            if (
              req.method === "POST" &&
              (action === "advance" || action === "stop")
            ) {
              if (action === "advance" && mode === "live")
                throw Error("The controlled live run advances itself; no checkpoint input was sent.");
              if (
                action === "advance"
                  ? !Number.isSafeInteger(body.sequence) ||
                    body.sequence < 1 ||
                    Object.keys(body).some((k) => k !== "sequence")
                  : Object.keys(body).length
              )
                throw Error("Unsupported checkpoint settings.");
              await call(
                `/api/host/runs/${job.engineId}/${action}`,
                "POST",
                action === "advance" ? { sequence: body.sequence } : {},
              );
              return json(200, { accepted: true });
            }
            if (req.method === "GET" && action === "assets" && hash) {
              const response = await call(
                `/api/host/runs/${job.engineId}/assets/${hash}.png`,
              );
              const bytes = Buffer.from(await response.arrayBuffer());
              if (job.deleted || job.discarding)
                return json(404, { error: "Not found" });
              res.writeHead(200, {
                "Content-Type": "image/png",
                "Cache-Control": "no-store",
              });
              return res.end(bytes);
            }
            if (req.method === "GET" && action === "frame") {
              const frame = metaLiveFrameSchema.parse(
                await (
                  await call(`/api/host/runs/${job.engineId}/frame`)
                ).json(),
              );
              const bytes = Buffer.from(frame.png, "base64");
              if (
                frame.runId !== job.engineId ||
                bytes.length < 24 || bytes.length > 4 * 1024 * 1024 ||
                bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
                bytes.readUInt32BE(16) !== frame.width ||
                bytes.readUInt32BE(20) !== frame.height ||
                digest(bytes) !== frame.imageHash
              )
                throw Error("The live picture did not match its browser.");
              if (job.deleted || job.discarding)
                return json(404, { error: "Not found" });
              return json(200, frame);
            }
            if (req.method === "GET" && (!action || action === "live")) {
              const value = await data(job),
                view = jobView(job, value);
              return json(
                200,
                pathname.startsWith("/api/offline/")
                  ? { ...view, ...(value ?? {}), ...(pendingStart(job) ? { pendingStart: pendingStart(job) } : {}), jobId: job.id }
                  : action === "live"
                    ? {
                        progress: view.progress,
                        thoughts: metaThoughtDelta(view.progress, url.searchParams.get("since")),
                        liveFindings: [],
                      }
                    : view,
              );
            }
          }
          return json(405, {
            error: "This control is not available in the local offline proof.",
          });
        }
        const file = html ? files.get("/") : files.get(pathname);
        if (req.method !== "GET" || !file)
          return json(404, { error: "Not found" });
        res.writeHead(200, {
          "Content-Type": file.type,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Cross-Origin-Resource-Policy": "same-origin",
          "Content-Security-Policy":
            "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'; script-src 'self'; font-src 'self'",
        });
        res.end(file.bytes);
      } catch (error) {
        json(400, {
          error:
            error.message || "The local proof could not complete this action.",
        });
      }
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
    hostOrigin = `http://127.0.0.1:${server.address().port}`;
    return {
      url: hostOrigin,
      manifest,
      engineOrigin: origin,
      close: async () => {
        await new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        });
        try {
          await writes;
        } finally {
          await stopEngine();
        }
      },
    };
  } catch (error) {
    await stopEngine();
    throw error;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (key) => process.argv[process.argv.indexOf(key) + 1];
  if (!process.argv.includes("--engine") || !process.argv.includes("--data"))
    throw Error(
      "Pass --engine <public project folder> --data <dedicated local records folder>.",
    );
  const server = await startMetaFunnelProof({
    engineRoot: arg("--engine"),
    dataDirectory: arg("--data"),
    engineNode: process.argv.includes("--engine-node")
      ? arg("--engine-node")
      : process.execPath,
    controlledLiveProof: process.argv.includes("--controlled-live-proof"),
    publicWebsites: process.argv.includes("--public-websites"),
  });
  console.log(
    `Cavioo setup with local ${server.manifest.mode} engine: ${server.url}/audits/new`,
  );
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => void server.close().then(() => process.exit()));
}

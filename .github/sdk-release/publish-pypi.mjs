// sdk-generation/ci/publisher/publish-pypi.mjs
import { readFile, writeFile as writeFile2, mkdir as mkdir4, mkdtemp as mkdtemp3, rm as rm4 } from "node:fs/promises";
import { join as join4, dirname as dirname2, resolve as resolve4 } from "node:path";
import { tmpdir as tmpdir2 } from "node:os";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getIDToken } from "@actions/core";

// scripts/public-api/lib/github-publisher-identity.mjs
import { createHash, createPublicKey, verify } from "node:crypto";
var ISSUER = "https://token.actions.githubusercontent.com";
var AUDIENCE = "https://github.com/reacon-io";
var OWNER_ID = "334414696";
var FAMILIES = ["typescript", "python", "go", "rust", "php", "ruby", "java", "kotlin", "csharp"];
var id = (value) => typeof value === "string" && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
var sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
async function githubPublisherIdentity({ configuration: configuration2, environment, fetchImpl = fetch, tokenProvider, now = Date.now }) {
  const env = { ...environment }, config = { ...configuration2 };
  const repository = `reacon-io/reacon-${config.family}`;
  const workflowRef = `${repository}/.github/workflows/publish.yml@refs/heads/main`;
  if (config.formatVersion !== 1 || !FAMILIES.includes(config.family) || !id(String(config.repositoryId)) || config.repository !== repository || !["private", "public"].includes(config.visibility)) throw new Error("Expected reviewed company publisher configuration");
  if (env.GITHUB_ACTIONS !== "true" || env.GITHUB_SERVER_URL !== "https://github.com" || env.GITHUB_API_URL !== "https://api.github.com" || env.GITHUB_REPOSITORY !== repository || env.GITHUB_REPOSITORY_ID !== String(config.repositoryId) || env.GITHUB_REPOSITORY_OWNER !== "reacon-io" || env.GITHUB_REPOSITORY_OWNER_ID !== OWNER_ID || env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_WORKFLOW_REF !== workflowRef || !sha(env.GITHUB_SHA) || env.GITHUB_WORKFLOW_SHA !== env.GITHUB_SHA || env.RUNNER_ENVIRONMENT !== "github-hosted" || !id(env.GITHUB_RUN_ID) || !id(env.GITHUB_RUN_ATTEMPT) || typeof env.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== "string" || !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN || env.ACTIONS_ID_TOKEN_REQUEST_TOKEN.length > 32768 || /\s/.test(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)) throw new Error("Not the configured company publisher job");
  let endpoint;
  try {
    endpoint = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL);
    if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".actions.githubusercontent.com") || endpoint.port || endpoint.username || endpoint.password || endpoint.hash) throw new Error();
  } catch {
    throw new Error("Unexpected GitHub job identity endpoint");
  }
  if (endpoint.searchParams.has("audience")) throw new Error("Unexpected preselected GitHub identity audience");
  const requestUrl = `${env.ACTIONS_ID_TOKEN_REQUEST_URL}${endpoint.search ? "&" : "?"}audience=${encodeURIComponent(AUDIENCE)}`;
  async function json(url, headers = {}) {
    let response2;
    try {
      response2 = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(3e4), headers: { Accept: "application/json", "User-Agent": "reacon-sdk-publisher", ...headers } });
    } catch {
      throw new Error("GitHub identity transport failed; details suppressed");
    }
    if (response2.status !== 200) {
      let detail = "";
      try {
        const reader = response2.body.getReader(), chunks = [];
        let size = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 8192) {
            await reader.cancel();
            throw new Error();
          }
          chunks.push(value);
        }
        const text = Buffer.concat(chunks).toString("utf8");
        let message;
        try {
          const body = JSON.parse(text);
          message = body.message ?? body.error_description ?? body.error?.message ?? body.error;
        } catch {
          message = text.replace(/<[^>]*>/g, " ");
        }
        if (typeof message === "string") detail = message.split(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).join("[redacted]").replace(/https?:\/\/\S+/g, "[url]").replace(/[A-Za-z0-9_./+=-]{32,}/g, "[redacted]").replace(/[^A-Za-z0-9 .,;:!?()\[\]'_-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 300);
      } catch {
      }
      throw new Error(`GitHub identity HTTP ${response2.status}${detail ? `: ${detail}` : ""}`);
    }
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of response2.body) {
        size += chunk.length;
        if (size > 128 * 1024) throw new Error();
        chunks.push(chunk);
      }
      return JSON.parse(Buffer.concat(chunks));
    } catch {
      throw new Error("Invalid GitHub identity response; details suppressed");
    }
  }
  let response;
  if (tokenProvider !== void 0) {
    if (typeof tokenProvider !== "function") throw new Error("Invalid GitHub token provider");
    try {
      response = { value: await tokenProvider(AUDIENCE) };
    } catch (error) {
      const message = typeof error?.message === "string" ? error.message : "";
      const envelope = message.match(/Failed to get ID Token\.[\s\S]*?Error Code\s*:\s*(\d{3})\s+Error Message:\s*([\s\S]*)/);
      let detail = "";
      if (envelope) {
        const safe = envelope[2].split(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).join("[redacted]").split(env.ACTIONS_ID_TOKEN_REQUEST_URL).join("[url]").replace(/https?:\/\/\S+/g, "[url]").replace(/[A-Za-z0-9_./+=-]{32,}/g, "[redacted]").replace(/[^A-Za-z0-9 .,;:!?()\[\]'_-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
        detail = ` HTTP ${envelope[1]}${safe ? `: ${safe}` : ""}`;
      }
      throw new Error(`Official GitHub token request failed${detail || "; details suppressed"}`);
    }
  } else response = await json(requestUrl, { Authorization: `Bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` });
  let header, claims, parts;
  try {
    if (typeof response.value !== "string" || response.value.length > 32768) throw new Error();
    parts = response.value.split(".");
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw new Error();
    header = JSON.parse(Buffer.from(parts[0], "base64url"));
    claims = JSON.parse(Buffer.from(parts[1], "base64url"));
    if (header.alg !== "RS256" || header.typ !== "JWT" || typeof header.kid !== "string" || !header.kid || header.crit !== void 0 || !claims || typeof claims !== "object" || Array.isArray(claims)) throw new Error();
  } catch {
    throw new Error("Malformed GitHub job identity token");
  }
  const keySet = await json(`${ISSUER}/.well-known/jwks`);
  try {
    if (!Array.isArray(keySet.keys) || keySet.keys.length > 100) throw new Error();
    const candidates = keySet.keys.filter((key3) => key3.kid === header.kid);
    if (candidates.length !== 1 || candidates[0].kty !== "RSA" || candidates[0].use !== "sig" || candidates[0].alg !== void 0 && candidates[0].alg !== "RS256") throw new Error();
    const key2 = createPublicKey({ key: candidates[0], format: "jwk" });
    if (key2.asymmetricKeyDetails.modulusLength < 2048 || !verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key2, Buffer.from(parts[2], "base64url"))) throw new Error();
  } catch {
    throw new Error("GitHub job identity signature verification failed");
  }
  const seconds = now() / 1e3;
  if (!Number.isFinite(seconds) || claims.iss !== ISSUER || claims.aud !== AUDIENCE || claims.sub !== `repo:reacon-io@${OWNER_ID}/reacon-${config.family}@${config.repositoryId}:environment:release` || claims.environment !== "release" || claims.repository !== repository || claims.repository_id !== String(config.repositoryId) || claims.repository_owner !== "reacon-io" || claims.repository_owner_id !== OWNER_ID || claims.repository_visibility !== config.visibility || claims.ref !== "refs/heads/main" || claims.ref_type !== "branch" || claims.sha !== env.GITHUB_SHA || claims.workflow_ref !== workflowRef || claims.workflow_sha !== env.GITHUB_WORKFLOW_SHA || claims.event_name !== "workflow_dispatch" || claims.runner_environment !== "github-hosted" || claims.run_id !== env.GITHUB_RUN_ID || claims.run_attempt !== env.GITHUB_RUN_ATTEMPT || claims.job_workflow_ref !== void 0 && claims.job_workflow_ref !== workflowRef || claims.job_workflow_sha !== void 0 && claims.job_workflow_sha !== env.GITHUB_SHA || !Number.isFinite(claims.exp) || !Number.isFinite(claims.iat) || !Number.isFinite(claims.nbf) || claims.exp < seconds + 30 || claims.exp > seconds + 900 || claims.iat > seconds + 30 || claims.iat < seconds - 600 || claims.nbf > seconds + 30 || claims.exp <= claims.iat || claims.nbf > claims.exp) throw new Error("GitHub job identity claims do not match this publisher");
  return {
    formatVersion: 1,
    kind: "sdk-github-publisher-identity",
    observedAt: new Date(now()).toISOString(),
    family: config.family,
    repository,
    repositoryId: Number(config.repositoryId),
    visibility: config.visibility,
    workflow: "publish.yml",
    workflowRef,
    workflowCommit: env.GITHUB_WORKFLOW_SHA,
    sourceCommit: env.GITHUB_SHA,
    environment: "release",
    event: "workflow_dispatch",
    runnerEnvironment: "github-hosted",
    runId: Number(env.GITHUB_RUN_ID),
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
    workerId: `gh-${config.repositoryId}-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT}`,
    signatureVerified: true,
    signingKeyId: header.kid,
    verifiedClaimsSha256: createHash("sha256").update(parts[1]).digest("hex"),
    tokenExpiresAt: new Date(claims.exp * 1e3).toISOString()
  };
}

// scripts/public-api/lib/github-release-state.mjs
import { mkdir as mkdir2, mkdtemp, realpath as realpath2, rm as rm2 } from "node:fs/promises";
import { join as join2, resolve as resolve3 } from "node:path";

// scripts/public-api/lib/git-release-state.mjs
import { mkdir, lstat, realpath, rm } from "node:fs/promises";
import { resolve as resolve2, join } from "node:path";
import { randomUUID } from "node:crypto";

// scripts/public-api/contract.mjs
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key2, item]) => [key2, canonical(item)]));
  return value;
}

// scripts/public-api/lib/generator.mjs
import { createHash as createHash2 } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
var root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
var sha256 = (bytes) => createHash2("sha256").update(bytes).digest("hex");

// scripts/public-api/lib/release-versions.mjs
var PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.([1-9]\d*))?$/;
var STAGES = { alpha: 0, beta: 1, rc: 2 };
var VERSION_PROPERTY = { typescript: "npmVersion", python: "packageVersion", go: "packageVersion", rust: "packageVersion", php: "artifactVersion", ruby: "gemVersion", java: "artifactVersion", kotlin: "artifactVersion", csharp: "packageVersion" };
function parseReleaseVersion(version) {
  if (typeof version !== "string" || version.length > 64) throw new Error("Invalid canonical release version");
  const match = PATTERN.exec(version);
  if (!match) throw new Error("Use X.Y.Z or X.Y.Z-(alpha|beta|rc).N with N >= 1");
  const core = match.slice(1, 4).map(Number);
  const sequence = match[5] === void 0 ? null : Number(match[5]);
  if (core.some((number) => !Number.isSafeInteger(number) || number > 65534) || sequence !== null && (!Number.isSafeInteger(sequence) || sequence > 2147483647)) throw new Error("Release version exceeds the cross-language numeric limits");
  return { canonical: version, core, base: core.join("."), stage: match[4] ?? null, sequence, prerelease: sequence !== null };
}
function compareCore(left, right) {
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return Math.sign(left[index] - right[index]);
  return 0;
}
function compareReleaseVersions(left, right) {
  const a = parseReleaseVersion(left), b = parseReleaseVersion(right);
  const core = compareCore(a.core, b.core);
  if (core) return core;
  if (a.prerelease !== b.prerelease) return a.prerelease ? -1 : 1;
  if (!a.prerelease) return 0;
  return Math.sign(STAGES[a.stage] - STAGES[b.stage]) || Math.sign(a.sequence - b.sequence);
}
function renderReleaseVersion(family, version, { availability = "private", packageName } = {}) {
  if (!Object.hasOwn(VERSION_PROPERTY, family)) throw new Error("Unknown SDK family");
  if (!["private", "public"].includes(availability)) throw new Error("Explicit API availability must be private or public");
  const parsed = parseReleaseVersion(version);
  if (availability === "private" && !parsed.prerelease) throw new Error("Private API environments may publish prereleases only");
  let packageVersion = parsed.canonical;
  if (family === "python" && parsed.prerelease) packageVersion = `${parsed.base}${{ alpha: "a", beta: "b", rc: "rc" }[parsed.stage]}${parsed.sequence}`;
  if (family === "ruby" && parsed.prerelease) packageVersion = `${parsed.base}.${parsed.stage}.${parsed.sequence}`;
  const result = {
    family,
    canonicalVersion: version,
    packageVersion,
    gitTag: `v${version}`,
    prerelease: parsed.prerelease,
    availability,
    generatorProperties: { [VERSION_PROPERTY[family]]: packageVersion },
    publishable: false
  };
  if (family === "typescript") result.npmDistTag = parsed.prerelease ? "next" : "latest";
  if (family === "go") {
    if (typeof packageName !== "string" || !/^github\.com\/reacon-io\/reacon-go(?:\/v(?:[2-9]|[1-9]\d+))?$/.test(packageName)) throw new Error("Go requires the explicit company module identity");
    const base = packageName.replace(/\/v\d+$/, "");
    result.modulePath = parsed.core[0] >= 2 ? `${base}/v${parsed.core[0]}` : base;
    result.requiresModulePathChange = result.modulePath !== packageName;
    result.moduleVersion = `v${version}`;
  }
  if (family === "php") result.composerVersionSource = "git-tag";
  return result;
}

// scripts/public-api/lib/release-state.mjs
import { isDeepStrictEqual } from "node:util";

// scripts/public-api/lib/central-deployment-state.mjs
var hash = (value) => /^[a-f0-9]{64}$/.test(value ?? "");
var id2 = (value) => /^[a-z0-9][a-z0-9-]{0,79}$/.test(value ?? "");
var uuid = (value) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value ?? "");
var instant = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
var states = ["PENDING", "VALIDATING", "VALIDATED", "PUBLISHING", "PUBLISHED", "FAILED"];
function fields(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key2) => !allowed.includes(key2))) throw new Error("Invalid Central journal fields");
}
var centralDeploymentName = (family, version, bundleSha256) => `reacon-${family}-${version}-${bundleSha256}`;
function validateCentralDeployment(value, { family, version, identitySha256, attempts }) {
  fields(value, [
    "identitySha256",
    "bundleManifestSha256",
    "bundleSha256",
    "deploymentName",
    "uploadAttemptId",
    "uploadStartedAt",
    "absence",
    "deploymentId",
    "uploadEvidenceSha256",
    "status",
    "staged",
    "publishAttempts"
  ]);
  const attempt = attempts.find((entry) => entry.attemptId === value.uploadAttemptId);
  if (!["java", "kotlin"].includes(family) || value.identitySha256 !== identitySha256 || !hash(value.identitySha256) || !hash(value.bundleManifestSha256) || !hash(value.bundleSha256) || value.deploymentName !== centralDeploymentName(family, version, value.bundleSha256) || !attempt || !instant(value.uploadStartedAt) || Date.parse(value.uploadStartedAt) < Date.parse(attempt.startedAt) || !Array.isArray(value.publishAttempts)) throw new Error("Invalid Central upload binding");
  fields(value.absence, ["evidenceSha256", "at"]);
  if (!hash(value.absence.evidenceSha256) || !instant(value.absence.at) || Date.parse(value.uploadStartedAt) - Date.parse(value.absence.at) < 0 || Date.parse(value.uploadStartedAt) - Date.parse(value.absence.at) > 6e4) throw new Error("Central upload absence evidence is stale");
  if (value.deploymentId !== void 0 && (!uuid(value.deploymentId) || !hash(value.uploadEvidenceSha256))) throw new Error("Invalid Central deployment receipt");
  if (value.uploadEvidenceSha256 && !value.deploymentId) throw new Error("Orphan Central receipt");
  if (value.status) {
    fields(value.status, ["state", "evidenceSha256", "at"]);
    if (!value.deploymentId || !states.includes(value.status.state) || !hash(value.status.evidenceSha256) || !instant(value.status.at) || Date.parse(value.status.at) < Date.parse(value.uploadStartedAt)) throw new Error("Invalid Central status evidence");
  }
  if (value.staged) {
    fields(value.staged, ["evidenceSha256", "at"]);
    if (!value.deploymentId || !hash(value.staged.evidenceSha256) || !instant(value.staged.at) || Date.parse(value.staged.at) < Date.parse(value.uploadStartedAt)) throw new Error("Invalid staged bundle evidence");
  }
  const seen = /* @__PURE__ */ new Set();
  for (const publish of value.publishAttempts) {
    fields(publish, ["attemptId", "at", "acknowledgementSha256"]);
    const worker = attempts.find((entry) => entry.attemptId === publish.attemptId);
    if (!value.deploymentId || !value.staged || !id2(publish.attemptId) || !worker || seen.has(publish.attemptId) || !instant(publish.at) || Date.parse(publish.at) < Date.parse(worker.startedAt) || Date.parse(publish.at) < Date.parse(value.uploadStartedAt) || publish.acknowledgementSha256 !== void 0 && !hash(publish.acknowledgementSha256)) throw new Error("Invalid Central publication intent");
    seen.add(publish.attemptId);
  }
  return value;
}

// scripts/public-api/lib/release-state.mjs
var FAMILIES2 = ["typescript", "python", "go", "rust", "php", "ruby", "java", "kotlin", "csharp"];
var PUBLICATION_UNITS = {
  typescript: ["npm"],
  python: ["wheel", "sdist"],
  go: ["tag"],
  rust: ["crate"],
  php: ["tag", "packagist"],
  ruby: ["gem"],
  java: ["central"],
  kotlin: ["central"],
  csharp: ["nuget"]
};
var hash2 = (value) => {
  if (!/^[a-f0-9]{64}$/.test(value ?? "")) throw new Error("Checksummed evidence is required");
  return value;
};
var id3 = (value) => {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(value ?? "")) throw new Error("Invalid release/run identity");
  return value;
};
var instant2 = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Invalid event time");
  return Date.parse(value);
};
function keys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key2) => !allowed.includes(key2))) throw new Error("Unexpected release-state fields");
}
function emptyReleaseState() {
  return { formatVersion: 1, sequence: 0, activeReleaseId: null, docsReleaseId: null, baselines: {}, versionOwners: {}, releases: {} };
}
var allPublished = (pkg) => pkg.mode === "unchanged" || Object.values(pkg.units ?? {}).length > 0 && Object.values(pkg.units).every((unit) => unit.state === "published");
var allInstalled = (pkg) => Boolean(pkg.installEvidenceSha256) && allPublished(pkg);
function releasePhase(release) {
  if (release.superseded) return "superseded";
  if (release.docs) return "docs_promoted";
  const packages = Object.values(release.packages);
  if (packages.every(allInstalled)) return "install_verified";
  if (packages.every(allPublished)) return "published";
  const units = packages.filter((pkg) => pkg.mode === "changed").flatMap((pkg) => Object.values(pkg.units ?? {}));
  if (units.some((unit) => unit.state === "collision")) return "collision";
  if (units.some((unit) => unit.state === "published")) return "partially_published";
  if (units.some((unit) => ["publishing", "uncertain"].includes(unit.state))) return "publishing";
  if (release.compatibility) return "deployment_verified";
  if (packages.every((pkg) => pkg.mode === "unchanged" || pkg.testEvidenceSha256)) return "tested";
  return "prepared";
}
function validateReleaseState(state) {
  keys(state, ["formatVersion", "sequence", "activeReleaseId", "docsReleaseId", "baselines", "versionOwners", "releases"]);
  if (state.formatVersion !== 1 || !Number.isSafeInteger(state.sequence) || state.sequence < 0 || !state.baselines || !state.versionOwners || !state.releases) throw new Error("Invalid release state");
  keys(state.baselines, FAMILIES2);
  keys(state.releases, Object.keys(state.releases));
  keys(state.versionOwners, Object.keys(state.versionOwners));
  if (state.activeReleaseId !== null && !Object.hasOwn(state.releases, state.activeReleaseId)) throw new Error("Active release is missing");
  if (state.docsReleaseId !== null && !state.releases[state.docsReleaseId]?.docs) throw new Error("Published docs release is missing");
  const events = /* @__PURE__ */ new Set();
  for (const [releaseId2, release] of Object.entries(state.releases)) {
    id3(releaseId2);
    keys(release, ["releaseId", "sourceRevision", "contractSha256", "generationSha256", "availability", "packages", "events", "compatibility", "docs", "superseded"]);
    if (!/^[a-f0-9]{40}$/.test(release.sourceRevision) || !["private", "public"].includes(release.availability)) throw new Error("Invalid release source or availability");
    hash2(release.contractSha256);
    hash2(release.generationSha256);
    if (release.releaseId !== releaseId2 || JSON.stringify(Object.keys(release.packages).sort()) !== JSON.stringify([...FAMILIES2].sort())) throw new Error("Release state must include every SDK family");
    if (!Array.isArray(release.events) || !release.events.length || !release.docs && !release.superseded && state.activeReleaseId !== releaseId2 || (release.docs || release.superseded) && state.activeReleaseId === releaseId2 || release.docs && release.superseded) throw new Error("Invalid release lifecycle");
    let lastSequence = 0, lastTime = 0;
    for (const event of release.events) {
      keys(event, ["sequence", "action", "at"]);
      const time = instant2(event.at);
      if (!Number.isSafeInteger(event.sequence) || event.sequence <= lastSequence || event.sequence > state.sequence || events.has(event.sequence) || time < lastTime || !["versions_reserved", "candidate_tested", "compatibility_verified", "registry_observed", "publication_started", "previous_attempt_stopped", "public_install_verified", "docs_promoted", "release_superseded", "central_deployment_updated", "central_publication_resumed"].includes(event.action)) throw new Error("Invalid release event history");
      events.add(event.sequence);
      lastSequence = event.sequence;
      lastTime = time;
    }
    if (release.compatibility) {
      keys(release.compatibility, ["evidenceSha256", "expiresAt", "trigger"]);
      hash2(release.compatibility.evidenceSha256);
      instant2(release.compatibility.expiresAt);
      if (!["deployment", "sdk-only"].includes(release.compatibility.trigger)) throw new Error("Invalid compatibility trigger");
    }
    for (const [family, pkg] of Object.entries(release.packages)) {
      keys(pkg, ["mode", "canonicalVersion", "packageVersion", "previousVersion", "impact", "migrationDocumentSha256", "artifactManifestSha256", "sourceSha256", "testEvidenceSha256", "units", "installEvidenceSha256", "releaseId"]);
      if (!["changed", "unchanged"].includes(pkg.mode)) throw new Error("Invalid SDK package mode");
      const rendered = renderReleaseVersion(family, pkg.canonicalVersion, { availability: release.availability, packageName: family === "go" ? "github.com/reacon-io/reacon-go" : void 0 });
      if (pkg.packageVersion !== rendered.packageVersion) throw new Error("Invalid native package version");
      if (pkg.mode === "changed" && state.versionOwners[`${family}@${pkg.canonicalVersion}`] !== releaseId2) throw new Error("SDK reservation ownership mismatch");
      if (Boolean(pkg.units) !== Boolean(pkg.testEvidenceSha256)) throw new Error("Candidate test evidence and units must be bound together");
      if (pkg.units) {
        hash2(pkg.artifactManifestSha256);
        hash2(pkg.sourceSha256);
        hash2(pkg.testEvidenceSha256);
        if (JSON.stringify(Object.keys(pkg.units).sort()) !== JSON.stringify([...PUBLICATION_UNITS[family]].sort())) throw new Error("Invalid publication unit set");
        for (const unit of Object.values(pkg.units)) {
          keys(unit, ["identitySha256", "state", "attempts", "observation", "centralDeployment"]);
          hash2(unit.identitySha256);
          if (!["ready", "absent", "publishing", "uncertain", "published", "collision"].includes(unit.state) || !Array.isArray(unit.attempts)) throw new Error("Invalid publication unit state");
          for (const attempt of unit.attempts) {
            keys(attempt, ["attemptId", "runId", "startedAt", "stoppedEvidenceSha256"]);
            id3(attempt.attemptId);
            id3(attempt.runId);
            instant2(attempt.startedAt);
            if (attempt.stoppedEvidenceSha256) hash2(attempt.stoppedEvidenceSha256);
          }
          if (unit.centralDeployment) validateCentralDeployment(unit.centralDeployment, {
            family,
            version: pkg.packageVersion,
            identitySha256: unit.identitySha256,
            attempts: unit.attempts
          });
          if (unit.observation) {
            keys(unit.observation, ["status", "evidenceSha256", "at", "identitySha256"]);
            hash2(unit.observation.evidenceSha256);
            instant2(unit.observation.at);
            if (!["found", "absent", "unknown"].includes(unit.observation.status)) throw new Error("Invalid registry observation state");
            if (unit.observation.status === "found") hash2(unit.observation.identitySha256);
          }
          if (unit.state === "published" && (unit.observation?.status !== "found" || unit.observation.identitySha256 !== unit.identitySha256)) throw new Error("Published unit lacks matching registry evidence");
          if (unit.state === "collision" && (unit.observation?.status !== "found" || unit.observation.identitySha256 === unit.identitySha256)) throw new Error("Collision lacks mismatching registry evidence");
          if (unit.state === "publishing" && (!unit.attempts.length || unit.attempts.at(-1).stoppedEvidenceSha256)) throw new Error("Publishing unit lacks an active attempt");
          if (unit.state === "absent" && (unit.observation?.status !== "absent" || unit.attempts.length && !unit.attempts.at(-1).stoppedEvidenceSha256)) throw new Error("Unsafe retry state");
        }
      }
      if (pkg.installEvidenceSha256) {
        hash2(pkg.installEvidenceSha256);
        if (!allPublished(pkg)) throw new Error("Install evidence precedes publication");
      }
      if (pkg.mode === "unchanged") {
        const owner = state.releases[pkg.releaseId], original = owner?.packages[family];
        if (!owner || !(owner.docs || owner.superseded) || original?.mode !== "changed" || owner.events[0].sequence >= release.events[0].sequence || !allInstalled(original) || !isDeepStrictEqual(pkg, { ...original, mode: "unchanged", releaseId: owner.releaseId })) {
          throw new Error("Unchanged package must match an installed published baseline");
        }
      }
    }
    if (release.docs) {
      keys(release.docs, ["artifactSha256", "evidenceSha256", "at"]);
      hash2(release.docs.artifactSha256);
      hash2(release.docs.evidenceSha256);
      instant2(release.docs.at);
      if (!release.compatibility || !Object.values(release.packages).every(allInstalled)) throw new Error("Docs advanced before SDK qualification");
    }
    if (release.superseded) {
      keys(release.superseded, ["reason", "decisionEvidenceSha256", "at"]);
      hash2(release.superseded.decisionEvidenceSha256);
      instant2(release.superseded.at);
      if (!["version-collision", "withdraw-candidate", "corrective-release"].includes(release.superseded.reason)) throw new Error("Invalid supersession reason");
    }
  }
  if (events.size !== state.sequence) throw new Error("Release state event sequence has gaps");
  for (const [version, releaseId2] of Object.entries(state.versionOwners)) {
    const [family, canonicalVersion] = version.split("@");
    const pkg = state.releases[releaseId2]?.packages[family];
    if (!pkg || pkg.mode !== "changed" || pkg.canonicalVersion !== canonicalVersion || version !== `${family}@${canonicalVersion}`) throw new Error("Orphan SDK reservation");
  }
  for (const [family, baseline] of Object.entries(state.baselines)) {
    const { releaseId: releaseId2, ...pkg } = baseline;
    if (!allPublished(pkg) || !isDeepStrictEqual(pkg, state.releases[releaseId2]?.packages[family])) throw new Error("Published baseline does not match its release");
  }
  for (const family of FAMILIES2) {
    const published = Object.values(state.releases).filter((release) => release.packages[family].mode === "changed" && allPublished(release.packages[family])).sort((a, b) => compareReleaseVersions(a.packages[family].canonicalVersion, b.packages[family].canonicalVersion));
    if (published.length && state.baselines[family]?.releaseId !== published.at(-1).releaseId) throw new Error("Latest successful publication baseline was lost");
  }
  return state;
}

// scripts/public-api/lib/git-release-state.mjs
var REF = "refs/heads/main";
var TRACKING = "refs/remotes/release/main";
var FILE = "release-state.json";
var bytesFor = (state) => Buffer.from(JSON.stringify(canonical(state), null, 2) + "\n");
var ConcurrentReleaseState = class extends Error {
  constructor() {
    super("Release state advanced concurrently; reload before continuing");
    this.name = "ConcurrentReleaseState";
  }
};
var UncertainReleaseStateCommit = class extends Error {
  constructor(commit) {
    super("Release-state push outcome is uncertain; reconcile before any publication");
    this.name = "UncertainReleaseStateCommit";
    this.commit = commit;
  }
};
async function gitReleaseStateStore({ directory: directory2, remote, runGit = defaultRunGit }) {
  const hosted = remote === "https://github.com/reacon-io/reacon-sdk-releases.git";
  if (!hosted && (typeof remote !== "string" || !remote.startsWith("/") || await realpath(remote) !== remote)) throw new Error("Release state remote must be the company repo or an explicit real local path");
  directory2 = resolve2(directory2);
  await mkdir(directory2, { recursive: true, mode: 448 });
  if (await realpath(directory2) !== directory2 || !(await lstat(directory2)).isDirectory()) throw new Error("Release state checkout must not use symlinks");
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key2]) => !key2.startsWith("GIT_")));
  Object.assign(baseEnv, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Reacon SDK Releases",
    GIT_AUTHOR_EMAIL: "sdk-releases@reacon.io",
    GIT_COMMITTER_NAME: "Reacon SDK Releases",
    GIT_COMMITTER_EMAIL: "sdk-releases@reacon.io"
  });
  const git = (args, input, extraEnv) => runGit([
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.attributesFile=/dev/null",
    "-c",
    "credential.helper=",
    "-c",
    "fetch.recurseSubmodules=false",
    "--git-dir",
    directory2,
    ...args
  ], input, { ...baseEnv, ...extraEnv });
  try {
    await lstat(join(directory2, "HEAD"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await runGit(["-c", "init.templateDir=", "init", "--bare", "--object-format=sha1", directory2], void 0, baseEnv);
  }
  if (String(await git(["rev-parse", "--is-bare-repository"])).trim() !== "true") throw new Error("Dedicated bare state checkout required");
  async function read() {
    await git(["fetch", "--no-tags", "--no-write-fetch-head", remote, `+${REF}:${TRACKING}`]);
    const commit2 = String(await git(["rev-parse", TRACKING])).trim();
    if (!/^[a-f0-9]{40}$/.test(commit2)) throw new Error("Unexpected state repository object format");
    const entry = String(await git(["ls-tree", commit2, "--", FILE])).trim();
    let state;
    if (!entry) state = emptyReleaseState();
    else {
      if (!/^100644 blob [a-f0-9]{40}\trelease-state\.json$/.test(entry)) throw new Error("Release state must be a regular Git blob");
      state = validateReleaseState(JSON.parse(await git(["show", `${commit2}:${FILE}`])));
    }
    return { commit: commit2, state, stateSha256: sha256(bytesFor(state)) };
  }
  async function commit({ expectedCommit, state }) {
    validateReleaseState(state);
    const current = await read();
    if (current.commit !== expectedCommit) throw new ConcurrentReleaseState();
    const bytes = bytesFor(state);
    if (sha256(bytes) === current.stateSha256) return current;
    if (state.sequence !== current.state.sequence + 1) throw new Error("One state event per compare-and-swap commit is required");
    const index = join(directory2, `index-${randomUUID()}`), env = { GIT_INDEX_FILE: index };
    let nextCommit;
    try {
      await git(["read-tree", expectedCommit], void 0, env);
      const blob = String(await git(["hash-object", "-w", "--stdin", "--no-filters"], bytes)).trim();
      await git(["update-index", "--add", "--cacheinfo", `100644,${blob},${FILE}`], void 0, env);
      const tree = String(await git(["write-tree"], void 0, env)).trim();
      nextCommit = String(await git(["commit-tree", tree, "-p", expectedCommit], Buffer.from(`SDK release state event ${state.sequence}
`))).trim();
    } finally {
      await rm(index, { force: true });
      await rm(`${index}.lock`, { force: true });
    }
    try {
      await git(["push", "--porcelain", remote, `${nextCommit}:${REF}`]);
    } catch {
      let observed2;
      try {
        observed2 = await read();
      } catch {
        throw new UncertainReleaseStateCommit(nextCommit);
      }
      if (observed2.commit === nextCommit) return observed2;
      if (observed2.commit !== expectedCommit) throw new ConcurrentReleaseState();
      throw new Error("Release state push was rejected; do not start publication");
    }
    let observed;
    try {
      observed = await read();
    } catch {
      throw new UncertainReleaseStateCommit(nextCommit);
    }
    if (observed.commit !== nextCommit) throw new ConcurrentReleaseState();
    return observed;
  }
  return { read, commit, remote, directory: directory2 };
}
async function defaultRunGit(args, input, env) {
  const { spawn: spawn2 } = await import("node:child_process");
  return await new Promise((resolveRun, reject) => {
    const child = spawn2("/usr/bin/git", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 3e4);
    const chunks = [];
    let size = 0;
    const diagnostics = [];
    let diagnosticSize = 0;
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) child.kill("SIGTERM");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      diagnosticSize += chunk.length;
      if (diagnosticSize <= 16384) diagnostics.push(chunk);
    });
    child.stdin.on("error", () => {
    });
    child.once("error", () => {
      clearTimeout(timeout);
      reject(new Error("Git state command failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0 && size <= 16 * 1024 * 1024) return resolveRun(Buffer.concat(chunks));
      const detail = Buffer.concat(diagnostics).toString("utf8");
      const category = timedOut ? "timeout" : /authentication failed|invalid username|could not read Username|error: 401|error: 403/i.test(detail) ? "authentication" : /Could not resolve host/i.test(detail) ? "dns" : /SSL certificate|certificate verify/i.test(detail) ? "tls" : /repository not found|repository .* not found/i.test(detail) ? "repository-unavailable" : /RPC failed|HTTP\/2|remote end hung up|connection reset|Failed to connect|error: 50[234]/i.test(detail) ? "transport" : "other";
      const error = new Error(`Git state command failed (${category})`);
      error.gitFailureCategory = category;
      reject(error);
    });
    child.stdin.end(input);
  });
}

// scripts/public-api/lib/github-release-access.mjs
import { createPrivateKey, sign } from "node:crypto";
var API = "https://api.github.com";
var API_VERSION = "2026-03-10";
var OWNER = "reacon-io";
var OWNER_ID2 = 334414696;
var MAX_RESPONSE = 2 * 1024 * 1024;
var RELEASE_PERMISSIONS = { metadata: "read", contents: "write", pull_requests: "write", actions: "write" };
var encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
var positiveId = (value) => Number.isSafeInteger(value) && value > 0;
var samePermissions = (actual, expected) => actual && Object.keys(actual).length === Object.keys(expected).length && Object.entries(expected).every(([name, level]) => actual[name] === level);
function appJwt(clientId, privateKey, now = Date.now()) {
  if (typeof clientId !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(clientId)) throw new Error("Invalid GitHub App client ID");
  if (!Number.isFinite(now) || now < 0) throw new Error("Invalid clock");
  let key2;
  try {
    key2 = createPrivateKey(privateKey);
  } catch {
    throw new Error("Invalid GitHub App private key");
  }
  if (key2.asymmetricKeyType !== "rsa" || key2.asymmetricKeyDetails.modulusLength < 2048) throw new Error("GitHub App key must be RSA, at least 2048 bits");
  const seconds = Math.floor(now / 1e3);
  const input = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: clientId, iat: seconds - 60, exp: seconds + 540 })}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), key2).toString("base64url")}`;
}
async function githubRequest(fetchImpl, token, path, { method = "GET", body, expectedStatus = 200 } = {}) {
  const validatedPath = path.replace(/(\/compare\/[a-f0-9]{40})\.\.\.([a-f0-9]{40})(?=\?|$)/, "$1-to-$2");
  if (!/^\/[A-Za-z0-9_/?=&.-]+$/.test(path) || path.startsWith("//") || validatedPath.includes("..")) throw new Error("Invalid GitHub API path");
  let response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(3e4),
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "reacon-sdk-release-access",
        ...body === void 0 ? {} : { "Content-Type": "application/json" }
      },
      ...body === void 0 ? {} : { body: JSON.stringify(body) }
    });
  } catch {
    throw new Error("GitHub API transport failed (details suppressed to protect credentials)");
  }
  if (response.status !== expectedStatus) {
    await response.body?.cancel();
    throw new Error(`GitHub API ${method} request failed: HTTP ${response.status}`);
  }
  if (expectedStatus === 204) {
    await response.body?.cancel();
    return;
  }
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > MAX_RESPONSE) throw new Error("Response too large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Invalid GitHub API JSON response");
  }
}
function validateRepositoryInventory(inventory, packages) {
  if (inventory.formatVersion !== 1 || inventory.organization !== OWNER || inventory.organizationId !== OWNER_ID2) throw new Error("Unexpected GitHub organization");
  if (!positiveId(inventory.releaseApp?.appId) || !positiveId(inventory.releaseApp?.installationId) || typeof inventory.releaseApp?.clientId !== "string") throw new Error("Recorded GitHub App identities are required");
  if (!samePermissions(inventory.releaseApp?.permissions, RELEASE_PERMISSIONS)) throw new Error("Release app may only use the approved repository permissions");
  const repos = [inventory.releaseStateRepository, ...inventory.sdkRepositories];
  if (repos.length !== 10 || new Set(repos.map((repo) => repo.name)).size !== 10 || new Set(repos.map((repo) => repo.repositoryId)).size !== 10 || repos.some((repo) => !positiveId(repo.repositoryId) || !/^reacon-[a-z-]+$/.test(repo.name) || !/^[a-f0-9]{40}$/.test(repo.initialCommit))) throw new Error("Invalid repository inventory");
  if (inventory.releaseStateRepository.name !== "reacon-sdk-releases" || inventory.releaseStateRepository.visibility !== "private") throw new Error("Release state must remain private");
  if (inventory.sdkRepositories.length !== packages.length || packages.some((pkg) => inventory.sdkRepositories.filter((repo) => repo.family === pkg.id && `${OWNER}/${repo.name}` === pkg.repository).length !== 1)) throw new Error("SDK repository identities disagree");
  return repos.map((repo) => repo.name).sort();
}
function githubReleaseStateCredentials(options) {
  const access = options.access ?? "read";
  if (!["read", "write"].includes(access)) throw new Error("Explicit read/write state access required");
  return repositoryCredentials(options, "state", access);
}
function repositoryCredentials({ inventory, packages, clientId, privateKey, fetchImpl = fetch, now = Date.now, visibility }, purpose, access) {
  validateRepositoryInventory(inventory, packages);
  const expectedVisibility = purpose === "sdk" ? "public" : ["actions", "dispatch"].includes(purpose) ? visibility : "private";
  const selected = purpose === "state" ? [inventory.releaseStateRepository] : inventory.sdkRepositories;
  const allowed = new Map(selected.map((repo) => [`${OWNER}/${repo.name}`, repo.repositoryId]));
  return async ({ repository }) => {
    if (!allowed.has(repository)) throw new Error(purpose === "state" ? "GitHub state token requires the private release-state repository" : "GitHub write token requires a selected SDK repository");
    const jwt = appJwt(clientId, privateKey, now());
    const app = await githubRequest(fetchImpl, jwt, "/app");
    if (app.id !== inventory.releaseApp.appId || clientId !== inventory.releaseApp.clientId || app.client_id !== clientId || app.slug !== inventory.releaseApp.desiredSlug || app.owner?.login !== OWNER || app.owner?.id !== OWNER_ID2 || app.owner?.type !== "Organization" || !samePermissions(app.permissions, RELEASE_PERMISSIONS)) throw new Error("Unexpected company GitHub App");
    const installation = await githubRequest(fetchImpl, jwt, `/orgs/${OWNER}/installation`);
    if (installation.id !== inventory.releaseApp.installationId || installation.app_id !== app.id || installation.app_slug !== app.slug || installation.account?.login !== OWNER || installation.account?.id !== OWNER_ID2 || installation.account?.type !== "Organization" || installation.repository_selection !== "selected" || installation.suspended_at !== null || !samePermissions(installation.permissions, RELEASE_PERMISSIONS)) throw new Error("Unexpected company GitHub installation");
    const permissions = {
      metadata: "read",
      contents: access,
      ...purpose === "review" ? { pull_requests: access } : {},
      ...["ci", "actions"].includes(purpose) ? { actions: "read" } : {},
      ...purpose === "dispatch" ? { actions: "write" } : {}
    };
    const grant = await githubRequest(fetchImpl, jwt, `/app/installations/${installation.id}/access_tokens`, {
      method: "POST",
      expectedStatus: 201,
      body: { repositories: [repository.split("/")[1]], permissions }
    });
    if (typeof grant.token !== "string" || !grant.token || /\s/.test(grant.token)) throw new Error("Invalid GitHub installation token");
    let handedOff = false, revoked = false;
    const revoke = async () => {
      if (revoked) return;
      await githubRequest(fetchImpl, grant.token, "/installation/token", { method: "DELETE", expectedStatus: 204 });
      revoked = true;
    };
    try {
      const expiresAt = Date.parse(grant.expires_at);
      if (!samePermissions(grant.permissions, permissions) || !Number.isFinite(expiresAt) || expiresAt - now() < 3e4 || expiresAt - now() > 65 * 6e4) throw new Error("GitHub write token is broader or longer-lived than requested");
      const listing = await githubRequest(fetchImpl, grant.token, "/installation/repositories?per_page=100");
      const repo = listing.repositories?.[0];
      if (listing.total_count !== 1 || !Array.isArray(listing.repositories) || listing.repositories.length !== 1 || repo?.full_name !== repository || repo.name !== repository.split("/")[1] || repo.id !== allowed.get(repository) || repo.owner?.login !== OWNER || repo.owner?.id !== OWNER_ID2 || repo.owner?.type !== "Organization" || repo.private !== (expectedVisibility === "private") || repo.archived || repo.disabled || repo.fork || repo.default_branch !== "main" || expiresAt - now() < 3e4) throw new Error("GitHub repository scope, visibility or ownership mismatch");
      handedOff = true;
      return {
        kind: "github-app-installation",
        repository,
        repositoryId: repo.id,
        organizationId: OWNER_ID2,
        installationId: installation.id,
        appId: app.id,
        visibility: expectedVisibility,
        permissions,
        token: grant.token,
        expiresAt,
        revoke
      };
    } finally {
      if (!handedOff) await revoke();
    }
  };
}

// scripts/public-api/lib/github-release-state.mjs
import { setTimeout as delay } from "node:timers/promises";
var RELEASE_STATE_REPOSITORY = "reacon-io/reacon-sdk-releases";
var REMOTE = `https://github.com/${RELEASE_STATE_REPOSITORY}.git`;
async function githubReleaseStateStore({
  directory: directory2,
  access = "read",
  inventory,
  packages,
  clientId,
  privateKey,
  fetchImpl = fetch,
  now = Date.now,
  runGit = defaultRunGit
}) {
  if (!["read", "write"].includes(access)) throw new Error("State access must be read or write");
  const getCredentials = githubReleaseStateCredentials({ inventory, packages, clientId, privateKey, fetchImpl, now, access });
  const parent = resolve3(directory2);
  await mkdir2(parent, { recursive: true, mode: 448 });
  if (await realpath2(parent) !== parent) throw new Error("State cache parent cannot use symlinks");
  const cache = await mkdtemp(join2(parent, "github-state-"));
  let closed = false, credentialCleanupFailed = false;
  const execute = async (args, input, env) => {
    if (closed) throw new Error("GitHub state store is closed");
    if (credentialCleanupFailed) throw new Error("GitHub state token revocation failed; stop and reconcile");
    const safeEnv = { PATH: "/usr/bin:/bin", HOME: cache, LANG: "C", LC_ALL: "C" };
    for (const key2 of [
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_GLOBAL",
      "GIT_ATTR_NOSYSTEM",
      "GIT_TERMINAL_PROMPT",
      "GIT_AUTHOR_NAME",
      "GIT_AUTHOR_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_COMMITTER_EMAIL",
      "GIT_INDEX_FILE"
    ]) {
      if (env[key2] !== void 0) safeEnv[key2] = env[key2];
    }
    const options = [
      "-c",
      "http.sslVerify=true",
      "-c",
      "http.followRedirects=false",
      "-c",
      "protocol.allow=never",
      "-c",
      "protocol.https.allow=always"
    ];
    if (!args.includes(REMOTE)) return runGit([...options, ...args], input, safeEnv);
    if (!args.includes("fetch") && !args.includes("push") || access === "read" && args.includes("push")) {
      throw new Error("Unexpected GitHub state transport operation");
    }
    for (let attempt = 0; ; attempt++) {
      const lease = await getCredentials({ repository: RELEASE_STATE_REPOSITORY });
      try {
        const authorization = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${lease.token}`).toString("base64")}`;
        return await runGit([...options, ...args], input, {
          ...safeEnv,
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `http.${REMOTE}.extraheader`,
          GIT_CONFIG_VALUE_0: authorization
        });
      } catch (error) {
        if (!args.includes("fetch") || attempt >= 2 || error.gitFailureCategory !== "repository-unavailable") throw error;
      } finally {
        try {
          await lease.revoke();
        } catch {
          credentialCleanupFailed = true;
          throw new Error("GitHub state token revocation failed; stop and reconcile");
        }
      }
      await delay(1e3);
    }
  };
  try {
    const store2 = await gitReleaseStateStore({ directory: cache, remote: REMOTE, runGit: execute });
    const read = async () => {
      const snapshot = await store2.read();
      if (snapshot.state.sequence === 0 && snapshot.commit !== inventory.releaseStateRepository.initialCommit) {
        throw new Error("Empty release state is only valid at the recorded bootstrap commit; reconcile repository history");
      }
      return snapshot;
    };
    return {
      read,
      async commit(request) {
        if (access !== "write") throw new Error("Read-only GitHub state store cannot commit");
        const before = await read();
        if (before.commit !== request.expectedCommit) throw new ConcurrentReleaseState();
        return store2.commit(request);
      },
      remote: REMOTE,
      access,
      async close() {
        closed = true;
        await rm2(cache, { recursive: true, force: true });
      }
    };
  } catch (error) {
    closed = true;
    await rm2(cache, { recursive: true, force: true });
    throw error;
  }
}

// scripts/public-api/lib/github-artifact.mjs
import { createHash as createHash3 } from "node:crypto";
async function downloadGithubArtifact({ repository, artifact, token, maxBytes, fetchImpl = fetch }) {
  if (!/^reacon-io\/reacon-[a-z]+$/.test(repository) || !Number.isSafeInteger(artifact?.id) || artifact.id <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || !Number.isSafeInteger(artifact.size) || artifact.size <= 0 || artifact.size > maxBytes || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) || artifact.expired !== false || typeof token !== "string" || !token)
    throw new Error("Invalid bounded GitHub artifact request");
  try {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/artifacts/${artifact.id}/zip`, {
      redirect: "manual",
      signal: AbortSignal.timeout(3e4),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10"
      }
    });
    if (response.status !== 302) throw new Error();
    const url = new URL(response.headers.get("location"));
    await response.body?.cancel();
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !(url.hostname.endsWith(".blob.core.windows.net") || url.hostname.endsWith(".actions.githubusercontent.com"))) throw new Error();
    const download = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(6e4) });
    if (download.status !== 200) throw new Error();
    const chunks = [];
    let size = 0;
    for await (const chunk of download.body) {
      size += chunk.length;
      if (size > maxBytes || size > artifact.size) throw new Error();
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.length !== artifact.size || `sha256:${createHash3("sha256").update(bytes).digest("hex")}` !== artifact.digest) throw new Error();
    return bytes;
  } catch {
    throw new Error("GitHub artifact retrieval or digest verification failed; transport details suppressed");
  }
}

// scripts/public-api/lib/native-package-upload.mjs
import { spawn } from "node:child_process";
import { mkdtemp as mkdtemp2, mkdir as mkdir3, writeFile, rm as rm3, realpath as realpath3 } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join3, isAbsolute } from "node:path";
import { createHash as createHash4 } from "node:crypto";
var PUBLISHER_VERSIONS = { npm: "11.17.0", twine: "7.0.0" };
var NPM_REGISTRY = "https://registry.npmjs.org/";
var PYPI_UPLOAD = "https://upload.pypi.org/legacy/";
var OIDC_KEYS = [
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "GITHUB_ACTIONS",
  "GITHUB_REPOSITORY",
  "GITHUB_REPOSITORY_ID",
  "GITHUB_REPOSITORY_OWNER",
  "GITHUB_REPOSITORY_OWNER_ID",
  "GITHUB_SERVER_URL",
  "GITHUB_API_URL",
  "GITHUB_REF",
  "GITHUB_SHA",
  "GITHUB_RUN_ID",
  "GITHUB_RUN_ATTEMPT",
  "GITHUB_WORKFLOW_REF",
  "GITHUB_WORKFLOW_SHA",
  "GITHUB_EVENT_NAME",
  "RUNNER_ENVIRONMENT"
];
var NPM_METADATA = String.raw`
const {createRequire}=require('node:module');
const pacote=createRequire(process.argv[1])('pacote');
pacote.manifest(process.argv[2],{ignoreScripts:true,cache:process.argv[3],fullMetadata:true})
 .then(value=>console.log(JSON.stringify({name:value.name,version:value.version,publishConfig:value.publishConfig??{}})))
 .catch(()=>process.exit(1));
`;
var PYTHON_METADATA = String.raw`
import sys, tarfile, zipfile, email.parser, json
path = sys.argv[1]
if path.endswith('.whl'):
    with zipfile.ZipFile(path) as archive:
        entries = [entry for entry in archive.infolist() if entry.filename.endswith('.dist-info/METADATA')]
        if len(entries) != 1 or entries[0].file_size > 2 * 1024 * 1024: raise ValueError('Invalid wheel metadata')
        data = archive.read(entries[0])
else:
    with tarfile.open(path, 'r:gz') as archive:
        entries = [entry for entry in archive.getmembers() if entry.name.count('/') == 1 and entry.name.endswith('/PKG-INFO')]
        if len(entries) != 1 or not entries[0].isfile() or entries[0].size > 2 * 1024 * 1024: raise ValueError('Invalid sdist metadata')
        data = archive.extractfile(entries[0]).read()
metadata = email.parser.BytesParser().parsebytes(data)
if len(metadata.get_all('Name', [])) != 1 or len(metadata.get_all('Version', [])) != 1: raise ValueError('Ambiguous metadata')
print(json.dumps({'name': metadata['Name'], 'version': metadata['Version']}))
`;
function nativePackageUploader({
  family,
  toolPath,
  getCredentials,
  runProcess = runPublisherProcess,
  npmBootstrap = false,
  fetchImpl = fetch
}) {
  if (!["typescript", "python"].includes(family) || typeof toolPath !== "string" || !isAbsolute(toolPath)) throw new Error("Explicit publisher tool path is required");
  if (typeof npmBootstrap !== "boolean" || npmBootstrap && family !== "typescript") throw new Error("Bootstrap is explicit and npm-only");
  async function assertNewNpmPackage() {
    let response;
    try {
      response = await fetchImpl("https://registry.npmjs.org/@reacon-io%2fsdk", {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(15e3),
        headers: { Accept: "application/json" }
      });
    } catch {
      throw new Error("Cannot establish npm package absence for bootstrap");
    }
    await response.body?.cancel();
    if (response.status !== 404) throw new Error("Bootstrap requires an absent npm package, not merely an absent version");
  }
  async function execute({ identity: identity2, bytes, assertCurrentIntent }, publish) {
    if (publish && typeof assertCurrentIntent !== "function") throw new Error("Native publication requires a current durable-intent verifier");
    const filename = family === "typescript" ? `reacon-io-sdk-${identity2.version}.tgz` : identity2.filename;
    if (identity2.registry !== (family === "typescript" ? "npm" : "pypi") || identity2.packageName !== (family === "typescript" ? "@reacon-io/sdk" : "reacon-sdk") || !/^[0-9A-Za-z.-]+$/.test(identity2.version) || !/^[0-9A-Za-z_.-]+$/.test(filename) || identity2.filename !== filename || bytes.length !== identity2.size || sha256(bytes) !== identity2.sha256) throw new Error("Native uploader input differs from retained identity");
    await realpath3(toolPath);
    const tool = toolPath;
    const directory2 = await mkdtemp2(join3(tmpdir(), "reacon-publisher-"));
    try {
      await mkdir3(join3(directory2, "home"), { mode: 448 });
      const file = join3(directory2, filename);
      await writeFile(file, bytes, { flag: "wx", mode: 256 });
      const env = {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: join3(directory2, "home"),
        TMPDIR: directory2,
        LANG: "C.UTF-8",
        CI: "true",
        PYTHONNOUSERSITE: "1",
        PYTHON_KEYRING_BACKEND: "keyring.backends.null.Keyring",
        TWINE_NON_INTERACTIVE: "1",
        NPM_CONFIG_USERCONFIG: join3(directory2, "user.npmrc"),
        NPM_CONFIG_GLOBALCONFIG: join3(directory2, "global.npmrc"),
        NPM_CONFIG_CACHE: join3(directory2, "npm-cache"),
        NPM_CONFIG_LOGS_DIR: join3(directory2, "npm-logs")
      };
      await writeFile(env.NPM_CONFIG_USERCONFIG, "", { mode: 384 });
      await writeFile(env.NPM_CONFIG_GLOBALCONFIG, "", { mode: 384 });
      const command = family === "typescript" ? process.execPath : tool;
      const prefix = family === "typescript" ? [tool] : ["-I", "-m", "twine"];
      const run = async (args) => {
        try {
          return await runProcess({ command, args: [...prefix, ...args], cwd: directory2, env });
        } catch (error) {
          error.publicationDiagnostic = {
            stage: args[0],
            code: error.publisherCode ?? null,
            ...error.publisherSummary ? { summary: error.publisherSummary } : {}
          };
          throw error;
        }
      };
      const version = (await run(["--version"])).trim();
      if (family === "typescript" ? version !== PUBLISHER_VERSIONS.npm : !version.startsWith(`twine version ${PUBLISHER_VERSIONS.twine} `)) throw new Error("Publisher tool version differs from the pinned toolchain");
      if (family === "typescript") {
        const metadata = JSON.parse(await runProcess({ command, args: ["-e", NPM_METADATA, tool, file, env.NPM_CONFIG_CACHE], cwd: directory2, env }));
        const allowed = { registry: NPM_REGISTRY, access: "public", tag: identity2.version.includes("-") ? "next" : "latest" };
        if (metadata.name !== identity2.packageName || metadata.version !== identity2.version || !metadata.publishConfig || typeof metadata.publishConfig !== "object" || Array.isArray(metadata.publishConfig) || Object.entries(metadata.publishConfig).some(([key2, value]) => allowed[key2] !== value)) throw new Error("Unexpected npm publication configuration");
        const response = JSON.parse(await run([
          "publish",
          file,
          "--dry-run",
          "--json",
          "--ignore-scripts",
          "--provenance=false",
          "--access=public",
          "--tag",
          identity2.version.includes("-") ? "next" : "latest",
          "--registry",
          NPM_REGISTRY
        ]));
        const output = response[identity2.packageName];
        if (Object.keys(response).length !== 1 || output?.name !== identity2.packageName || output.version !== identity2.version || output.integrity !== `sha512-${createHash4("sha512").update(bytes).digest("base64")}`) throw new Error("npm would publish a different package identity");
      } else {
        const metadata = JSON.parse(await runProcess({ command: tool, args: ["-I", "-c", PYTHON_METADATA, file], cwd: directory2, env }));
        if (metadata.name.toLowerCase().replace(/[-_.]+/g, "-") !== identity2.packageName || metadata.version !== identity2.version) throw new Error("Python archive metadata differs from candidate identity");
        await run(["check", "--strict", file]);
      }
      if (!publish) return {
        registry: identity2.registry,
        filename,
        sha256: identity2.sha256,
        packageMetadataChecked: true,
        nativePreflightPassed: true,
        uploaded: false,
        publishable: false
      };
      await assertCurrentIntent();
      if (typeof getCredentials !== "function") throw new Error("Explicit publication credentials are required");
      const credentials = await getCredentials({ registry: identity2.registry, packageName: identity2.packageName });
      const repository = family === "typescript" ? "reacon-io/reacon-typescript" : "reacon-io/reacon-python";
      if (credentials.kind !== (npmBootstrap ? "github-oidc-npm-bootstrap" : "github-oidc") || !credentials.environment || Object.keys(credentials.environment).some((key2) => !OIDC_KEYS.includes(key2)) || credentials.environment.GITHUB_REPOSITORY !== repository || credentials.environment.GITHUB_ACTIONS !== "true" || credentials.environment.RUNNER_ENVIRONMENT !== "github-hosted" || credentials.environment.GITHUB_REF !== "refs/heads/main" || credentials.environment.GITHUB_EVENT_NAME !== "workflow_dispatch" || credentials.environment.GITHUB_WORKFLOW_REF !== `${repository}/.github/workflows/publish.yml@refs/heads/main` || credentials.environment.GITHUB_SERVER_URL !== "https://github.com" || !credentials.environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN || !credentials.environment.ACTIONS_ID_TOKEN_REQUEST_URL) throw new Error("Publication requires the company workflow OIDC environment");
      const requestUrl = new URL(credentials.environment.ACTIONS_ID_TOKEN_REQUEST_URL);
      if (requestUrl.protocol !== "https:" || !requestUrl.hostname.endsWith(".actions.githubusercontent.com") || requestUrl.port || requestUrl.username || requestUrl.password || requestUrl.hash) throw new Error("Unexpected GitHub OIDC endpoint");
      Object.assign(env, credentials.environment);
      if (npmBootstrap) {
        if (!/^\d+\.\d+\.\d+-(?:alpha|beta|rc)\.\d+$/.test(identity2.version) || typeof credentials.token !== "string" || !/^npm_[A-Za-z0-9]{30,500}$/.test(credentials.token))
          throw new Error("Initial npm registration requires a prerelease and explicit bootstrap credential");
        await assertNewNpmPackage();
        env.REACON_NPM_BOOTSTRAP_TOKEN = credentials.token;
        await writeFile(
          env.NPM_CONFIG_USERCONFIG,
          "//registry.npmjs.org/:_authToken=${REACON_NPM_BOOTSTRAP_TOKEN}\n",
          { mode: 384 }
        );
        if ((await run(["whoami", "--registry", NPM_REGISTRY])).trim() !== "reacon-achazal")
          throw new Error("Bootstrap credential must belong to the dedicated Reacon work account");
        await assertNewNpmPackage();
      }
      await assertCurrentIntent();
      if (family === "typescript") {
        await run([
          "publish",
          file,
          "--json",
          "--ignore-scripts",
          "--provenance",
          "--access=public",
          "--tag",
          identity2.version.includes("-") ? "next" : "latest",
          "--registry",
          NPM_REGISTRY
        ]);
      } else {
        env.TWINE_USERNAME = "__token__";
        await run(["upload", "--non-interactive", "--disable-progress-bar", "--repository-url", PYPI_UPLOAD, file]);
      }
      return { uploaded: true, registryVerificationRequired: true };
    } finally {
      await rm3(directory2, { recursive: true, force: true });
    }
  }
  return { preflight: (input) => execute(input, false), upload: (input) => execute(input, true) };
}
async function runPublisherProcess({ command, args, cwd, env }) {
  return await new Promise((resolve5, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let size = 0, failed = false, killTimer;
    function stop() {
      if (failed) return;
      failed = true;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
      }
      killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
        }
      }, 2e3);
    }
    const timer = setTimeout(stop, 12e4);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) stop();
      else chunks.push(chunk);
    });
    child.stderr.resume();
    const fail = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      const error = new Error("Native publisher command failed; details suppressed to protect credentials");
      try {
        const diagnostic = JSON.parse(Buffer.concat(chunks).toString("utf8")).error;
        const code = diagnostic?.code;
        if (["E401", "E403", "E404", "EOTP", "ENEEDAUTH", "EUSAGE", "EUNPROCESSABLE", "E422", "E409", "EPUBLISHCONFLICT", "EINTEGRITY", "EPRIVATE", "EINVALIDPROVENANCE"].includes(code)) error.publisherCode = code;
        if (error.publisherCode && typeof diagnostic.summary === "string") {
          let summary = diagnostic.summary;
          for (const [name, value] of Object.entries(env)) if (/TOKEN|PASSWORD|SECRET/i.test(name) && value) summary = summary.split(value).join("[redacted]");
          error.publisherSummary = summary.replace(/https?:\/\/\S+/g, "[url]").replace(/(?:npm_|gh[sopur]_)[A-Za-z0-9_]+/g, "[redacted]").replace(/eyJ[A-Za-z0-9_.-]+/g, "[redacted]").replace(/[A-Za-z0-9_+/=-]{40,}/g, "[redacted]").slice(0, 1e3);
        }
      } catch {
      }
      reject(error);
    };
    child.once("error", fail);
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (failed || code !== 0) fail();
      else resolve5(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

// scripts/public-api/lib/file-registry.mjs
import { createHash as createHash5 } from "node:crypto";

// sdk-generation/ci/source/package-artifacts.mjs
var MAX_BYTES = 256 * 1024 * 1024;
function validateArtifactNames(family, packageVersion, names2) {
  if (!Array.isArray(names2) || new Set(names2).size !== names2.length || names2.some((name) => !/^[A-Za-z0-9_.-]+$/.test(name))) throw new Error("Invalid package artifact filenames");
  const v = packageVersion;
  const maven = (name) => [`.jar`, `-sources.jar`, `-javadoc.jar`, `.pom`].map((suffix) => `${name}-${v}${suffix}`);
  const expected = {
    typescript: [`reacon-io-sdk-${v}.tgz`],
    go: [`.zip`, `.mod`, `.info`].map((suffix) => `v${v}${suffix}`),
    rust: [`reacon-sdk-${v}.crate`],
    php: [`reacon-sdk-${v}.zip`],
    ruby: [`reacon-sdk-${v}.gem`],
    java: maven("reacon-java"),
    kotlin: [...maven("reacon-kotlin"), `reacon-kotlin-${v}.module`],
    csharp: [`Reacon.Sdk.${v}.nupkg`],
    python: [`reacon_sdk-${v}-py3-none-any.whl`, `reacon_sdk-${v}.tar.gz`]
  }[family];
  if (!expected || JSON.stringify([...names2].sort()) !== JSON.stringify(expected.sort())) throw new Error(`Missing or unexpected ${family} package artifacts`);
}

// scripts/public-api/lib/package-artifacts.mjs
var MAX_BYTES2 = 256 * 1024 * 1024;

// scripts/public-api/lib/file-registry.mjs
var MAX_FILE = 256 * 1024 * 1024;
var jsonBytes = (value) => Buffer.from(JSON.stringify(canonical(value), null, 2) + "\n");
var names = { typescript: "@reacon-io/sdk", python: "reacon-sdk", ruby: "reacon-sdk", rust: "reacon-sdk" };
var registries = { typescript: "npm", python: "pypi", ruby: "rubygems", rust: "crates.io" };
var familyUnits = { typescript: { npm: ".tgz" }, python: { wheel: ".whl", sdist: ".tar.gz" }, ruby: { gem: ".gem" }, rust: { crate: ".crate" } };
var digest = (value) => /^[a-f0-9]{64}$/.test(value ?? "");
function registryUnitIdentity(manifest, unit) {
  if (!names[manifest.family] || manifest.formatVersion !== 1 || manifest.kind !== "sdk-package-artifacts" || manifest.publishable !== false || !digest(manifest.sourceSha256) || !digest(manifest.contractSha256)) throw new Error("Invalid registry candidate");
  const rendered = renderReleaseVersion(manifest.family, manifest.canonicalVersion, {
    availability: manifest.canonicalVersion.includes("-") ? "private" : "public"
  });
  if (rendered.packageVersion !== manifest.packageVersion) throw new Error("Registry version does not match candidate");
  validateArtifactNames(manifest.family, manifest.packageVersion, Object.keys(manifest.files));
  for (const file of Object.values(manifest.files)) if (!digest(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_FILE) throw new Error("Invalid registry file identity");
  const suffix = familyUnits[manifest.family]?.[unit];
  if (!suffix) throw new Error("Unsupported registry publication unit");
  const filename = Object.keys(manifest.files).find((name) => name.endsWith(suffix));
  const identity2 = {
    formatVersion: 1,
    kind: "sdk-registry-file",
    registry: registries[manifest.family],
    packageName: names[manifest.family],
    version: manifest.packageVersion,
    filename,
    ...manifest.files[filename]
  };
  return { identity: identity2, identitySha256: sha256(jsonBytes(identity2)) };
}
function artifactFileRegistry({
  manifest: input,
  readArtifact,
  retainEvidence,
  store: store2,
  upload,
  fetchImpl = fetch,
  now = () => (/* @__PURE__ */ new Date()).toISOString()
}) {
  const manifest = structuredClone(input), manifestSha256 = sha256(jsonBytes(manifest));
  if (!familyUnits[manifest.family]) throw new Error("Unsupported file registry");
  for (const unit of Object.keys(familyUnits[manifest.family])) registryUnitIdentity(manifest, unit);
  if (typeof readArtifact !== "function" || typeof retainEvidence !== "function") throw new Error("Retained artifact and evidence storage are required");
  function bind(subject) {
    const expected = registryUnitIdentity(manifest, subject.unit), pkg = subject.package;
    if (subject.family !== manifest.family || pkg?.canonicalVersion !== manifest.canonicalVersion || pkg.packageVersion !== manifest.packageVersion || pkg.artifactManifestSha256 !== manifestSha256 || pkg.sourceSha256 !== manifest.sourceSha256 || subject.contractSha256 !== manifest.contractSha256 || pkg.units?.[subject.unit]?.identitySha256 !== expected.identitySha256) throw new Error("Registry subject differs from retained candidate");
    return expected;
  }
  async function get(url, evidence, maxBytes) {
    const parsed = new URL(url);
    const hosts = {
      typescript: ["registry.npmjs.org"],
      python: ["pypi.org", "files.pythonhosted.org"],
      ruby: ["rubygems.org"],
      rust: ["crates.io", "static.crates.io"]
    }[manifest.family];
    if (parsed.protocol !== "https:" || !hosts.includes(parsed.hostname) || parsed.port || parsed.username || parsed.password || parsed.hash) throw new Error("Untrusted registry URL");
    let response;
    try {
      response = await fetchImpl(url, {
        redirect: "error",
        signal: AbortSignal.timeout(3e4),
        headers: {
          Accept: maxBytes === MAX_FILE ? "application/octet-stream" : "application/json",
          "User-Agent": "Reacon-SDK-Releases/1.0 (https://github.com/reacon-io)"
        }
      });
    } catch {
      evidence.requests.push({ url, outcome: "transport-error" });
      return { status: 0 };
    }
    const entry = { url, status: response.status };
    evidence.requests.push(entry);
    if (response.status !== 200) {
      await response.body?.cancel();
      return { status: response.status };
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) throw new Error("Oversized registry response");
        chunks.push(chunk);
      }
    } catch {
      entry.outcome = "invalid-body";
      return { status: 0 };
    }
    const bytes = Buffer.concat(chunks), stored = await retainEvidence(bytes);
    if (stored?.sha256 !== sha256(bytes)) throw new Error("Registry response was not retained correctly");
    entry.bodySha256 = stored.sha256;
    entry.size = bytes.length;
    return { status: 200, bytes };
  }
  async function inspect(subject) {
    const { identity: identity2, identitySha256 } = bind(subject);
    const evidence = {
      formatVersion: 1,
      kind: "sdk-registry-observation",
      observedAt: now(),
      registry: identity2.registry,
      packageName: identity2.packageName,
      version: identity2.version,
      unit: subject.unit,
      expectedIdentitySha256: identitySha256,
      requests: []
    };
    async function finish(status, actualIdentity2, reason) {
      Object.assign(evidence, { status, reason, ...actualIdentity2 ? { actualIdentity: actualIdentity2 } : {} });
      const bytes = jsonBytes(evidence), reference = await retainEvidence(bytes);
      if (reference?.sha256 !== sha256(bytes)) throw new Error("Registry observation was not retained correctly");
      return {
        status,
        evidenceSha256: reference.sha256,
        ...actualIdentity2 ? { identitySha256: sha256(jsonBytes(actualIdentity2)) } : {}
      };
    }
    const unknown = (reason) => finish("unknown", null, reason);
    const collision = (reason) => finish("found", {
      kind: "sdk-registry-conflict",
      expectedIdentitySha256: identitySha256,
      reason,
      observationsSha256: sha256(jsonBytes(evidence.requests))
    }, reason);
    const url = {
      typescript: `https://registry.npmjs.org/@reacon-io%2Fsdk/${identity2.version}`,
      python: `https://pypi.org/pypi/reacon-sdk/${identity2.version}/json`,
      ruby: `https://rubygems.org/api/v2/rubygems/reacon-sdk/versions/${identity2.version}.json?platform=ruby`,
      rust: `https://crates.io/api/v1/crates/reacon-sdk/${identity2.version}`
    }[manifest.family];
    const metadata = await get(url, evidence, 2 * 1024 * 1024);
    if (metadata.status === 404) return finish("absent", null, "version-not-found");
    if (metadata.status !== 200) return unknown("metadata-unavailable");
    let data;
    try {
      data = JSON.parse(metadata.bytes);
    } catch {
      return unknown("invalid-metadata");
    }
    if (!data || typeof data !== "object" || Array.isArray(data)) return unknown("invalid-metadata");
    let downloadUrl, published;
    if (manifest.family === "typescript") {
      if (data.name !== identity2.packageName || data.version !== identity2.version) return collision("package-metadata-mismatch");
      downloadUrl = data.dist?.tarball;
      if (downloadUrl !== `https://registry.npmjs.org/@reacon-io/sdk/-/sdk-${identity2.version}.tgz`) return unknown("unexpected-tarball-url");
      published = data.dist;
    } else if (manifest.family === "python") {
      if (typeof data.info?.name !== "string" || data.info.name.toLowerCase().replace(/[-_.]+/g, "-") !== identity2.packageName || data.info.version !== identity2.version) return collision("package-metadata-mismatch");
      if (!Array.isArray(data.urls)) return unknown("invalid-file-index");
      const allowed = Object.keys(manifest.files), seen = /* @__PURE__ */ new Set();
      for (const file of data.urls) {
        if (!allowed.includes(file.filename) || seen.has(file.filename)) return collision("unexpected-release-file");
        seen.add(file.filename);
      }
      published = data.urls.find((file) => file.filename === identity2.filename);
      if (!published) return finish("absent", null, "file-not-yet-uploaded");
      if (published.yanked !== false) return published.yanked === true ? collision("file-yanked") : unknown("invalid-yank-status");
      if (published.packagetype !== (subject.unit === "wheel" ? "bdist_wheel" : "sdist")) return collision("file-type-mismatch");
      downloadUrl = published.url;
      try {
        const parsed = new URL(downloadUrl);
        if (parsed.origin !== "https://files.pythonhosted.org" || parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.pathname.startsWith("/packages/") || decodeURIComponent(parsed.pathname.split("/").at(-1)) !== identity2.filename) throw new Error();
      } catch {
        return unknown("unexpected-file-url");
      }
    }
    if (manifest.family === "ruby") {
      if (data.name !== identity2.packageName || data.version !== identity2.version || data.platform !== "ruby") return collision("package-metadata-mismatch");
      if (data.yanked !== false) return data.yanked === true ? collision("file-yanked") : unknown("invalid-yank-status");
      downloadUrl = `https://rubygems.org/gems/${identity2.filename}`;
      if (data.gem_uri !== downloadUrl || !digest(data.sha)) return unknown("invalid-gem-metadata");
      published = data;
    } else if (manifest.family === "rust") {
      published = data.version;
      if (published?.crate !== identity2.packageName || published.num !== identity2.version) return collision("package-metadata-mismatch");
      if (published.yanked !== false) return published.yanked === true ? collision("file-yanked") : unknown("invalid-yank-status");
      if (!digest(published.checksum)) return unknown("invalid-crate-checksum");
      downloadUrl = `https://static.crates.io/crates/reacon-sdk/${identity2.filename}`;
    }
    const content = await get(downloadUrl, evidence, MAX_FILE);
    if (content.status !== 200) return unknown("package-download-unavailable");
    const actualIdentity = { ...identity2, sha256: sha256(content.bytes), size: content.bytes.length };
    if (manifest.family === "typescript") {
      const integrity = `sha512-${createHash5("sha512").update(content.bytes).digest("base64")}`;
      if (published.integrity !== integrity) return collision("registry-integrity-mismatch");
    } else if (manifest.family === "python") {
      if (published.digests?.sha256 !== actualIdentity.sha256 || published.size !== actualIdentity.size) return collision("registry-integrity-mismatch");
    } else if ((manifest.family === "ruby" ? published.sha : published.checksum) !== actualIdentity.sha256) return collision("registry-integrity-mismatch");
    return finish("found", actualIdentity, "downloaded-file-identity");
  }
  async function publish(subject) {
    const { identity: identity2, identitySha256 } = bind(subject);
    if (!store2 || typeof upload !== "function") throw new Error("Publication requires durable state and a trusted uploader");
    async function assertCurrentIntent() {
      const current = await store2.read(), release = current.state.releases[subject.releaseId];
      const pkg = release?.packages[subject.family], unit = pkg?.units?.[subject.unit], attempt = unit?.attempts.at(-1);
      const expires = Date.parse(release?.compatibility?.expiresAt), observedAt = Date.parse(now());
      if (current.state.activeReleaseId !== subject.releaseId || release?.sourceRevision !== subject.sourceRevision || release.contractSha256 !== subject.contractSha256 || pkg?.artifactManifestSha256 !== manifestSha256 || Object.values(release.packages).some((candidate) => Object.values(candidate.units ?? {}).some((item) => item.state === "collision")) || unit?.identitySha256 !== identitySha256 || unit.state !== "publishing" || attempt?.attemptId !== subject.attemptId || attempt.runId !== subject.runId || attempt.stoppedEvidenceSha256 || !Number.isFinite(expires) || !Number.isFinite(observedAt) || expires <= observedAt) throw new Error("No current durable publication intent");
    }
    await assertCurrentIntent();
    const bytes = Buffer.from(await readArtifact(identity2.sha256));
    if (sha256(bytes) !== identity2.sha256 || bytes.length !== identity2.size) throw new Error("Retained publication bytes changed");
    await upload({ identity: identity2, bytes, attemptId: subject.attemptId, runId: subject.runId, assertCurrentIntent });
  }
  return { inspect, publish, manifestSha256 };
}

// scripts/public-api/lib/file-publication-worker.mjs
async function runFilePublicationWorker({
  family,
  unitName,
  identity: identity2,
  releaseId: releaseId2,
  attemptId,
  store: store2,
  loadPackage,
  upload,
  retainEvidence,
  fetchImpl = fetch,
  now = () => (/* @__PURE__ */ new Date()).toISOString(),
  wait = (ms) => new Promise((resolve5) => setTimeout(resolve5, ms)),
  waitForIntentMs = 6e5
}) {
  const repositoryId = { typescript: 1390807111, python: 1390807788 }[family];
  const units = { typescript: ["npm"], python: ["wheel", "sdist"] }[family];
  if (!repositoryId || !units.includes(unitName) || identity2.family !== family || identity2.repository !== `reacon-io/reacon-${family}` || identity2.repositoryId !== repositoryId || identity2.visibility !== "public" || identity2.signatureVerified !== true || identity2.environment !== "release" || identity2.workerId !== `gh-${identity2.repositoryId}-${identity2.runId}-${identity2.runAttempt}` || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(releaseId2 ?? "") || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(attemptId ?? "") || !Number.isSafeInteger(waitForIntentMs) || waitForIntentMs < 0 || waitForIntentMs > 6e5) {
    throw new Error("Expected a verified public company file publisher identity and bounded attempt");
  }
  const started = Date.parse(now());
  if (!Number.isFinite(started)) throw new Error("Valid publication clock required");
  let snapshot, release, pkg, unit;
  for (; ; ) {
    snapshot = await store2.read();
    validateReleaseState(snapshot.state);
    release = snapshot.state.releases[releaseId2];
    pkg = release?.packages[family];
    unit = pkg?.units?.[unitName];
    if (snapshot.state.activeReleaseId !== releaseId2 || !release || release.superseded || releasePhase(release) === "collision" || !pkg?.testEvidenceSha256 || !unit || !release.compatibility || Date.parse(release.compatibility.expiresAt) <= Date.parse(now())) {
      throw new Error("Coordinator has not qualified an active, compatible SDK candidate");
    }
    const attempt = unit.attempts.at(-1);
    if (attempt?.attemptId === attemptId && attempt.runId === identity2.workerId && !attempt.stoppedEvidenceSha256) {
      if (!["publishing", "uncertain", "published"].includes(unit.state)) throw new Error("Attempt has no publication intent");
      break;
    }
    if (attempt && !attempt.stoppedEvidenceSha256 || !["ready", "absent"].includes(unit.state)) throw new Error("Another publication attempt owns this unit");
    if (Date.parse(now()) - started >= waitForIntentMs) throw new Error("No durable intent arrived for this worker; nothing uploaded");
    await wait(5e3);
  }
  const loaded = await loadPackage();
  const manifest = {
    formatVersion: 1,
    kind: "sdk-package-artifacts",
    family,
    canonicalVersion: pkg.canonicalVersion,
    packageVersion: pkg.packageVersion,
    sourceSha256: pkg.sourceSha256,
    contractSha256: release.contractSha256,
    files: loaded.files,
    publishable: false
  };
  const manifestSha256 = sha256(Buffer.from(JSON.stringify(canonical(manifest), null, 2) + "\n"));
  const expected = registryUnitIdentity(manifest, unitName);
  if (manifestSha256 !== pkg.artifactManifestSha256 || expected.identitySha256 !== unit.identitySha256 || !Buffer.isBuffer(loaded.bytes) || loaded.bytes.length !== expected.identity.size || sha256(loaded.bytes) !== expected.identity.sha256) throw new Error("CI package differs from the qualified release");
  const subject = {
    releaseId: releaseId2,
    sourceRevision: release.sourceRevision,
    contractSha256: release.contractSha256,
    family,
    unit: unitName,
    package: structuredClone(pkg),
    attemptId,
    runId: identity2.workerId
  };
  const registry = artifactFileRegistry({
    manifest,
    store: store2,
    upload,
    fetchImpl,
    now,
    retainEvidence,
    readArtifact: async (digest2) => {
      if (digest2 !== expected.identity.sha256) throw new Error("Unexpected artifact request");
      return loaded.bytes;
    }
  });
  const before = await registry.inspect(subject);
  let uploadAttempted = false, uploadReturned = false, uploadFailure = null;
  if (before.status === "found" && before.identitySha256 !== expected.identitySha256) throw new Error("Registry version collision; nothing uploaded");
  if (before.status === "absent" && unit.state === "publishing") {
    uploadAttempted = true;
    try {
      await registry.publish(subject);
      uploadReturned = true;
    } catch (error) {
      const known = [
        "Git state command failed",
        "GitHub state token revocation failed; stop and reconcile",
        "No current durable publication intent",
        "npm would publish a different package identity",
        "Bootstrap credential must belong to the dedicated Reacon work account",
        "Initial npm registration requires a prerelease and explicit bootstrap credential"
      ];
      uploadFailure = error.publicationDiagnostic ?? { stage: "upload", reason: known.includes(error.message) ? error.message : "Unrecognized upload error; details suppressed" };
    }
  }
  const after = uploadAttempted ? await registry.inspect(subject) : before;
  return {
    formatVersion: 1,
    kind: "sdk-file-publication-worker",
    family,
    unit: unitName,
    observedAt: now(),
    releaseId: releaseId2,
    attemptId,
    workerId: identity2.workerId,
    repository: identity2.repository,
    workflowCommit: identity2.workflowCommit,
    stateCommit: snapshot.commit,
    artifactManifestSha256: manifestSha256,
    identitySha256: expected.identitySha256,
    sourceRevision: release.sourceRevision,
    contractSha256: release.contractSha256,
    ciArtifact: loaded.ciArtifact,
    uploadAttempted,
    uploadReturned,
    uploadFailure,
    before,
    after,
    packagePublished: after.status === "found" && after.identitySha256 === expected.identitySha256,
    releaseStateUpdated: false,
    publicInstallVerified: false
  };
}

// sdk-generation/ci/publisher/publish-pypi.mjs
var directory = dirname2(fileURLToPath2(import.meta.url));
var configuration = JSON.parse(await readFile(join4(directory, "configuration.json")));
var identity = await githubPublisherIdentity({ configuration, environment: process.env, tokenProvider: () => getIDToken() });
if (identity.family !== "python") throw Error("Python publisher required");
var releaseId = process.env.REACON_RELEASE_ID;
var attemptPrefix = process.env.REACON_ATTEMPT_ID;
if (!/^[a-z0-9][a-z0-9-]{0,69}$/.test(attemptPrefix ?? "")) throw Error("Bounded unique attempt prefix required");
await mkdir4("sdk-release-results", { recursive: true });
await writeFile2("sdk-release-results/identity.json", JSON.stringify(identity, null, 2) + "\n");
var artifactId = Number(process.env.REACON_CI_ARTIFACT_ID);
if (!Number.isSafeInteger(artifactId) || artifactId <= 0 || !process.env.GITHUB_TOKEN) throw Error("Retained CI artifact required");
var key = Buffer.from(process.env.REACON_GITHUB_APP_PRIVATE_KEY ?? "");
delete process.env.REACON_GITHUB_APP_PRIVATE_KEY;
if (!key.length) throw Error("Company release-state reader credential missing");
var temporary = await mkdtemp3(join4(tmpdir2(), "reacon-pypi-worker-"));
var store;
try {
  const inventory = JSON.parse(await readFile(join4(directory, "github-bootstrap.json")));
  const { packages } = JSON.parse(await readFile(join4(directory, "package-identities.json")));
  store = await githubReleaseStateStore({
    directory: join4(temporary, "state"),
    access: "read",
    inventory,
    packages,
    clientId: inventory.releaseApp.clientId,
    privateKey: key
  });
  const artifact = await githubRequest(fetch, process.env.GITHUB_TOKEN, `/repos/${identity.repository}/actions/artifacts/${artifactId}`);
  const archive = await downloadGithubArtifact({
    repository: identity.repository,
    artifact: { ...artifact, size: artifact.size_in_bytes },
    token: process.env.GITHUB_TOKEN,
    maxBytes: 128 * 1024 * 1024
  });
  const zip = join4(temporary, "ci.zip");
  await writeFile2(zip, archive);
  await promisify(execFile)("python3", [join4(directory, "unpack-ci-packages.py"), zip, temporary], { timeout: 3e4 });
  const manifest = JSON.parse(await readFile(join4(temporary, "package-manifest.json")));
  const ciArtifact = { id: artifact.id, archiveSha256: sha256(archive), size: archive.length, workflowRunId: artifact.workflow_run?.id };
  const uploader = nativePackageUploader({
    family: "python",
    toolPath: process.env.REACON_PYTHON_PUBLISHER,
    getCredentials: async () => ({ kind: "github-oidc", environment: Object.fromEntries([
      "ACTIONS_ID_TOKEN_REQUEST_URL",
      "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
      "GITHUB_ACTIONS",
      "GITHUB_REPOSITORY",
      "GITHUB_REPOSITORY_ID",
      "GITHUB_REPOSITORY_OWNER",
      "GITHUB_REPOSITORY_OWNER_ID",
      "GITHUB_SERVER_URL",
      "GITHUB_API_URL",
      "GITHUB_REF",
      "GITHUB_SHA",
      "GITHUB_RUN_ID",
      "GITHUB_RUN_ATTEMPT",
      "GITHUB_WORKFLOW_REF",
      "GITHUB_WORKFLOW_SHA",
      "GITHUB_EVENT_NAME",
      "RUNNER_ENVIRONMENT"
    ].filter((name) => process.env[name] !== void 0).map((name) => [name, process.env[name]])) })
  });
  const retainEvidence = async (bytes) => {
    const digest2 = sha256(bytes);
    await writeFile2(resolve4("sdk-release-results", `${digest2}.bin`), bytes);
    return { sha256: digest2, size: bytes.length };
  };
  for (const unitName of ["wheel", "sdist"]) {
    const snapshot = await store.read(), release = snapshot.state.releases[releaseId];
    if (snapshot.state.activeReleaseId !== releaseId || !release || release.superseded) throw Error("Active reservation required");
    if (release.packages.python.units?.[unitName]?.state === "published") {
      await writeFile2(`sdk-release-results/${unitName}.json`, JSON.stringify({
        releaseId,
        unit: unitName,
        skipped: true,
        reason: "already-reconciled-published",
        uploadAttempted: false,
        stateCommit: snapshot.commit
      }) + "\n");
      continue;
    }
    console.log(`Publisher ${identity.workerId} waiting for ${unitName} intent.`);
    const report = await runFilePublicationWorker({
      family: "python",
      unitName,
      identity,
      releaseId,
      attemptId: `${attemptPrefix}-${unitName}`,
      store,
      upload: uploader.upload,
      retainEvidence,
      loadPackage: async () => {
        const suffix = unitName === "wheel" ? ".whl" : ".tar.gz";
        const names2 = Object.keys(manifest.files);
        if (names2.length !== 2 || !names2.some((name) => name.endsWith(".whl")) || !names2.some((name) => name.endsWith(".tar.gz")) || names2.some((name) => !/^[A-Za-z0-9_.-]+$/.test(name))) throw Error("Expected retained wheel and source distribution");
        const filename = names2.find((name) => name.endsWith(suffix));
        return { files: manifest.files, bytes: await readFile(join4(temporary, "artifacts", filename)), ciArtifact };
      }
    });
    await writeFile2(`sdk-release-results/${unitName}.json`, JSON.stringify(report, null, 2) + "\n");
    if (!report.packagePublished) throw Error("PyPI outcome requires reconciliation; no automatic retry");
    console.log(`Exact ${unitName} observed on PyPI; awaiting coordinator reconciliation.`);
  }
} finally {
  await store?.close();
  key.fill(0);
  await rm4(temporary, { recursive: true, force: true });
}

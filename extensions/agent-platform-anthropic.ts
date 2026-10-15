import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve as resolvePath } from "node:path";
import type {
  Api,
  AssistantMessageEventStream,
  Model,
  RefreshModelsContext,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/oauth";
import { builtinProviders, getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  ExtensionAPI,
  ModelRegistry,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "agent-platform-anthropic";
const PROVIDER_API = "agent-platform-anthropic-api";
const PROVIDER_BASE_URL = "https://aiplatform.googleapis.com";
/**
 * Fixed wire value required by Agent Platform's Anthropic endpoint. It predates the
 * product rename; Google rejects any other value with 400 "Invalid API version".
 */
const AGENT_PLATFORM_ANTHROPIC_VERSION = "vertex-2023-10-16";
const GOOGLE_TOKEN_URI = "https://oauth2.googleapis.com/token";
const GOOGLE_CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const TOKEN_LIFETIME_S = 3600;

/** Multi-region endpoint first; the regional endpoint is tried on 404 (not offered) or 429 (quota). */
const LOCATIONS = {
  eu: ["eu", "europe-west1"],
  us: ["us", "us-east5"],
  global: ["global"],
} as const satisfies Record<string, readonly string[]>;
type Location = keyof typeof LOCATIONS;

/** Agent Platform bills Claude in multi-region and regional endpoints 10% above global. */
const COST_MULTIPLIER: Record<Location, number> = { eu: 1.1, us: 1.1, global: 1 };

interface ServiceAccountKey {
  project_id: string;
  client_email: string;
  private_key: string;
  private_key_id?: string;
  token_uri?: string;
}

/** Persisted by pi in auth.json. `refresh` is the key-file path; the private key is never copied. */
interface AgentPlatformCredentials extends OAuthCredentials {
  projectId: string;
  location: Location;
  clientEmail: string;
}

/** Request auth handed from `getApiKey` to `streamSimple` through pi's `apiKey` channel. */
interface RequestAuth {
  projectId: string;
  location: Location;
  accessToken: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLocation(value: unknown): value is Location {
  return typeof value === "string" && Object.hasOwn(LOCATIONS, value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// ---------------------------------------------------------------------------
// Service account → access token
// ---------------------------------------------------------------------------

function expandKeyFilePath(raw: string): string {
  const path = raw.trim();
  if (!path) throw new Error("Service account key file path is empty.");
  return resolvePath(path.replace(/^~(?=$|\/)/, homedir()));
}

async function readServiceAccountKey(path: string): Promise<ServiceAccountKey> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read service account key file ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !isRecord(parsed) ||
    parsed.type !== "service_account" ||
    !nonEmptyString(parsed.project_id) ||
    !nonEmptyString(parsed.client_email) ||
    !nonEmptyString(parsed.private_key)
  ) {
    throw new Error(
      `${path} is not a Google service account key (expected type "service_account" with project_id, client_email, and private_key).`,
    );
  }
  return {
    project_id: parsed.project_id,
    client_email: parsed.client_email,
    private_key: parsed.private_key,
    private_key_id: nonEmptyString(parsed.private_key_id) ? parsed.private_key_id : undefined,
    token_uri: nonEmptyString(parsed.token_uri) ? parsed.token_uri : undefined,
  };
}

const base64UrlJson = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** OAuth 2.0 JWT bearer grant (RFC 7523) for a Google service account. */
async function mintAccessToken(
  key: ServiceAccountKey,
  signal?: AbortSignal,
): Promise<{ access: string; expires: number }> {
  const tokenUri = key.token_uri ?? GOOGLE_TOKEN_URI;
  const iat = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
    ...(key.private_key_id && { kid: key.private_key_id }),
  };
  const claims = {
    iss: key.client_email,
    scope: GOOGLE_CLOUD_PLATFORM_SCOPE,
    aud: tokenUri,
    iat,
    exp: iat + TOKEN_LIFETIME_S,
  };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(key.private_key, "base64url");

  const response = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
    signal,
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok || !isRecord(payload) || !nonEmptyString(payload.access_token)) {
    const reason = isRecord(payload)
      ? (payload.error_description ?? payload.error ?? `HTTP ${response.status}`)
      : `HTTP ${response.status}`;
    throw new Error(`Google token exchange failed for ${key.client_email}: ${String(reason)}`);
  }
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : TOKEN_LIFETIME_S;
  return { access: payload.access_token, expires: Date.now() + expiresIn * 1000 };
}

async function createCredentials(
  keyFilePath: string,
  location: Location,
  signal?: AbortSignal,
): Promise<AgentPlatformCredentials> {
  const key = await readServiceAccountKey(keyFilePath);
  const token = await mintAccessToken(key, signal);
  return {
    refresh: keyFilePath,
    ...token,
    projectId: key.project_id,
    location,
    clientEmail: key.client_email,
  };
}

async function login(callbacks: OAuthLoginCallbacks): Promise<AgentPlatformCredentials> {
  const keyFilePath = expandKeyFilePath(
    await callbacks.onPrompt({
      message: "Path to Google service account JSON key file",
      placeholder: "~/my-project-1234abcd.json",
    }),
  );
  const selected = await callbacks.onSelect({
    message: "Agent Platform endpoint",
    options: [
      { id: "eu", label: "EU multi-region (fallback europe-west1)" },
      { id: "us", label: "US multi-region (fallback us-east5)" },
      { id: "global", label: "Global" },
    ],
  });
  const location = isLocation(selected) ? selected : "eu";
  callbacks.onProgress?.(`Exchanging service account key ${keyFilePath} for an access token…`);
  const credentials = await createCredentials(keyFilePath, location, callbacks.signal);
  callbacks.onProgress?.(
    `Authenticated as ${credentials.clientEmail} for project ${credentials.projectId} (${location}).`,
  );
  return credentials;
}

async function refreshToken(
  credentials: OAuthCredentials,
  signal: AbortSignal,
): Promise<AgentPlatformCredentials> {
  if (!nonEmptyString(credentials.refresh)) {
    throw new Error(
      `Stored credential has no service account key path. Run /login ${PROVIDER_ID}.`,
    );
  }
  const location = isLocation(credentials.location) ? credentials.location : "eu";
  return createCredentials(credentials.refresh, location, signal);
}

function getApiKey(credentials: OAuthCredentials): string {
  if (!nonEmptyString(credentials.projectId) || !isLocation(credentials.location)) {
    throw new Error(`Stored credential is incomplete. Run /login ${PROVIDER_ID}.`);
  }
  const auth: RequestAuth = {
    projectId: credentials.projectId,
    location: credentials.location,
    accessToken: credentials.access,
  };
  return JSON.stringify(auth);
}

function decodeRequestAuth(apiKey: string | undefined): RequestAuth {
  let parsed: unknown;
  try {
    parsed = apiKey ? JSON.parse(apiKey) : undefined;
  } catch {
    parsed = undefined;
  }
  if (
    !isRecord(parsed) ||
    !nonEmptyString(parsed.projectId) ||
    !isLocation(parsed.location) ||
    !nonEmptyString(parsed.accessToken)
  ) {
    throw new Error(
      `Missing Google Agent Platform credentials. Run "/login ${PROVIDER_ID}" and enter the path to a service account JSON key.`,
    );
  }
  return {
    projectId: parsed.projectId,
    location: parsed.location,
    accessToken: parsed.accessToken,
  };
}

// ---------------------------------------------------------------------------
// Transport: pi's Anthropic Messages implementation, rerouted to Agent Platform
// ---------------------------------------------------------------------------

function endpointHost(location: string): string {
  if (location === "global") return "aiplatform.googleapis.com";
  if (/^[a-z]{2}$/.test(location)) return `aiplatform.${location}.rep.googleapis.com`;
  return `${location}-aiplatform.googleapis.com`;
}

/** pi uses `claude-haiku-4-5-20251001`; Agent Platform publishes `claude-haiku-4-5@20251001`. */
function publisherModelId(modelId: string): string {
  return modelId.replace(/-(\d{8})$/, "@$1");
}

/**
 * Wraps fetch for the Anthropic SDK: Agent Platform takes the model in the URL, the API
 * version in the body, and a Google OAuth bearer token instead of `x-api-key`.
 */
function agentPlatformFetch(auth: RequestAuth, baseFetch: typeof fetch): typeof fetch {
  return async (_input, init) => {
    if (typeof init?.body !== "string") throw new Error("Unexpected Anthropic request body.");
    const { model, ...body }: Record<string, unknown> = JSON.parse(init.body);
    if (!nonEmptyString(model)) throw new Error("Anthropic request has no model.");

    const headers = new Headers(init.headers);
    headers.delete("x-api-key");
    headers.set("authorization", `Bearer ${auth.accessToken}`);
    const request: RequestInit = {
      ...init,
      headers,
      body: JSON.stringify({ ...body, anthropic_version: AGENT_PLATFORM_ANTHROPIC_VERSION }),
    };

    const locations = LOCATIONS[auth.location];
    const path = `publishers/anthropic/models/${encodeURIComponent(publisherModelId(model))}:streamRawPredict`;
    for (let i = 0; ; i++) {
      const location = locations[i];
      const url = `https://${endpointHost(location)}/v1/projects/${auth.projectId}/locations/${location}/${path}`;
      const response = await baseFetch(url, request);
      const canFallBack = response.status === 404 || response.status === 429;
      if (!canFallBack || i === locations.length - 1) return response;
      await response.body?.cancel();
    }
  };
}

const anthropic = builtinProviders().find((provider) => provider.id === "anthropic");

function streamSimple(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  if (!anthropic) throw new Error("pi's built-in Anthropic provider is unavailable.");
  const auth = decodeRequestAuth(options?.apiKey);
  return anthropic.streamSimple(model, context, {
    ...options,
    apiKey: auth.accessToken,
    fetch: agentPlatformFetch(auth, options?.fetch ?? globalThis.fetch),
  });
}

// ---------------------------------------------------------------------------
// Models: projected from pi's own Anthropic catalog
// ---------------------------------------------------------------------------

function projectAnthropicModels(models: readonly Model<Api>[]): ProviderModelConfig[] {
  return models
    .filter((model) => model.provider === "anthropic" && model.api === "anthropic-messages")
    .map(
      ({ provider: _provider, api: _api, baseUrl: _baseUrl, headers: _headers, ...model }) => model,
    );
}

function priceForLocation(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[] {
  const multiplier = isLocation(credentials.location) ? COST_MULTIPLIER[credentials.location] : 1;
  if (multiplier === 1) return models;
  const scale = (value: number) => Math.round(value * multiplier * 1e9) / 1e9;
  return models.map((model) => ({
    ...model,
    cost: {
      input: scale(model.cost.input),
      output: scale(model.cost.output),
      cacheRead: scale(model.cost.cacheRead),
      cacheWrite: scale(model.cost.cacheWrite),
      ...(model.cost.tiers && {
        tiers: model.cost.tiers.map((tier) => ({
          ...tier,
          input: scale(tier.input),
          output: scale(tier.output),
          cacheRead: scale(tier.cacheRead),
          cacheWrite: scale(tier.cacheWrite),
        })),
      }),
    },
  }));
}

function mergeById(
  bundled: ProviderModelConfig[],
  source: ProviderModelConfig[],
): ProviderModelConfig[] {
  const merged = new Map(bundled.map((model) => [model.id, model]));
  for (const model of source) merged.set(model.id, model);
  return [...merged.values()];
}

export default function (pi: ExtensionAPI) {
  const bundledModels = projectAnthropicModels(getBuiltinModels("anthropic"));
  // Captured in session_start; refreshModels cannot reach the registry on its own.
  let modelRegistry: ModelRegistry | undefined;

  /** Source priority: pi's live catalog, then our persisted projection, then the bundled list. */
  async function refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
    if (context.signal.aborted) return bundledModels;
    const live = projectAnthropicModels(modelRegistry?.getProvider("anthropic")?.getModels() ?? []);
    if (live.length > 0) {
      const models = mergeById(bundledModels, live).map((model): Model<Api> => ({
        ...model,
        provider: PROVIDER_ID,
        api: PROVIDER_API,
        baseUrl: PROVIDER_BASE_URL,
      }));
      await context.publish({ persist: { models, checkedAt: Date.now() } });
      return mergeById(bundledModels, live);
    }
    const stored = (context.stored?.models ?? [])
      .filter((model) => model.provider === PROVIDER_ID && model.api === PROVIDER_API)
      .map(
        ({ provider: _provider, api: _api, baseUrl: _baseUrl, headers: _headers, ...model }) =>
          model,
      );
    return mergeById(bundledModels, stored);
  }

  pi.registerProvider(PROVIDER_ID, {
    name: "Google Agent Platform (Anthropic)",
    api: PROVIDER_API,
    baseUrl: PROVIDER_BASE_URL,
    models: bundledModels,
    refreshModels,
    streamSimple,
    oauth: {
      name: "Google service account key (Agent Platform)",
      login,
      refreshToken,
      getApiKey,
      modifyModels: priceForLocation,
    },
  });

  pi.on("session_start", (_event, ctx) => {
    modelRegistry = ctx.modelRegistry;
  });
}

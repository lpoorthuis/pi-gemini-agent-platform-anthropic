import { execFileSync } from "node:child_process";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  calculateCost,
  type Context,
  createAssistantMessageEventStream,
  type ImageContent,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_LOCATION = "europe-west1";
const DEFAULT_MULTI_LOCATION = "eu";
const DEFAULT_CONTEXT_WINDOW = 200000;
const HAIKU_CONTEXT_WINDOW = 200000;
const ONE_MILLION_CONTEXT_WINDOW = 1000000;
const DEFAULT_MAX_TOKENS = 64000;
const OPUS_MAX_TOKENS = 128000;
const ANTHROPIC_VERSION = "vertex-2023-10-16";
const ACCESS_TOKEN_TTL_MS = 55 * 60 * 1000;
const AGENT_PLATFORM_OVERFLOW_PATTERN = /token limit|context.*exceed|too many tokens/i;

const DEFAULT_MODELS = [
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5@20251001",
];

type EndpointProfileName = "regional" | "multi";

interface AgentPlatformEndpointProfile {
  name: EndpointProfileName;
  baseUrl: string;
  location: string;
}

interface ModelLimits {
  contextWindow: number;
  maxTokens: number;
}

interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

type ModelLimitsOverride = Partial<ModelLimits>;

interface RuntimeConfig {
  endpointProfiles: Record<EndpointProfileName, AgentPlatformEndpointProfile | undefined>;
  endpointOverrides: Record<string, EndpointProfileName[]>;
}

const DEFAULT_MODEL_LIMITS: Record<string, ModelLimits> = {
  "claude-opus-4-7": {
    contextWindow: ONE_MILLION_CONTEXT_WINDOW,
    maxTokens: OPUS_MAX_TOKENS,
  },
  "claude-opus-4-6": {
    contextWindow: ONE_MILLION_CONTEXT_WINDOW,
    maxTokens: OPUS_MAX_TOKENS,
  },
  "claude-sonnet-4-6": {
    contextWindow: ONE_MILLION_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
  "claude-haiku-4-5@20251001": {
    contextWindow: HAIKU_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
};

const DEFAULT_MODEL_ENDPOINT_ORDER: Record<string, EndpointProfileName[]> = {
  "claude-opus-4-7": ["multi", "regional"],
  "claude-opus-4-6": ["multi", "regional"],
  "claude-sonnet-4-6": ["multi", "regional"],
  "claude-haiku-4-5@20251001": ["multi", "regional"],
};

const OPUS_COST: ModelCost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const SONNET_COST: ModelCost = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const HAIKU_COST: ModelCost = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
const DEFAULT_MODEL_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const MODEL_COSTS: Record<string, ModelCost> = {
  "claude-opus-4-7": OPUS_COST,
  "claude-opus-4-6": OPUS_COST,
  "claude-sonnet-4-6": SONNET_COST,
  "claude-haiku-4-5@20251001": HAIKU_COST,
  "claude-haiku-4-5-20251001": HAIKU_COST,
};

const DISPLAY_NAMES: Record<string, string> = {
  "claude-opus-4-7": "Claude Opus 4.7",
  "claude-opus-4-6": "Claude Opus 4.6",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-haiku-4-5@20251001": "Claude Haiku 4.5",
  "claude-haiku-4-5-20251001": "Claude Haiku 4.5",
};

type AdaptiveThinkingEffort = "low" | "medium" | "high" | "max";

const ADAPTIVE_THINKING_LEVEL_MAP: Record<string, AdaptiveThinkingEffort> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

let cachedAccessToken: { value: string; expiresAt: number } | undefined;

function dedupe<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function parsePositiveInt(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

function isOneMillionModelAlias(modelId: string): boolean {
  return /\[1m\]/i.test(modelId);
}

function stripOneMillionModelAlias(modelId: string): string {
  return isOneMillionModelAlias(modelId) ? modelId.replace(/\[1m\]/gi, "").trim() : modelId;
}

function normalizeAnthropicPublisherModelId(modelId: string): string {
  return modelId.replace(/^(claude-haiku-4-5)-(\d{8})$/i, "$1@$2");
}

function resolveAgentPlatformRequestModelId(modelId: string): string {
  return normalizeAnthropicPublisherModelId(stripOneMillionModelAlias(modelId));
}

function resolveModelCost(modelId: string): ModelCost {
  const requestModelId = resolveAgentPlatformRequestModelId(modelId);
  const configuredCost = MODEL_COSTS[modelId] || MODEL_COSTS[requestModelId];
  if (configuredCost) return configuredCost;

  if (/claude-opus/i.test(requestModelId)) return OPUS_COST;
  if (/claude-sonnet/i.test(requestModelId)) return SONNET_COST;
  if (/claude-haiku/i.test(requestModelId)) return HAIKU_COST;
  return DEFAULT_MODEL_COST;
}

function resolveModelDisplayName(modelId: string): string {
  const requestModelId = resolveAgentPlatformRequestModelId(modelId);
  return DISPLAY_NAMES[modelId] || DISPLAY_NAMES[requestModelId] || modelId;
}

function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDFFF]/g, "\uFFFD");
}

function mapStopReason(reason: string): StopReason {
  switch (reason) {
    case "end_turn":
    case "pause_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "toolUse";
    default:
      return "error";
  }
}

function debugWarningsEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.AGENT_PLATFORM_ANTHROPIC_DEBUG?.trim() ?? "");
}

function parseStreamJson(raw: string): unknown | undefined {
  try {
    return JSON.parse(raw);
  } catch (error) {
    if (debugWarningsEnabled()) {
      console.warn(
        `[agent-platform-anthropic] Failed to parse stream event: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return undefined;
  }
}

function convertContentBlocks(content: (TextContent | ImageContent)[]) {
  const hasImages = content.some((c) => c.type === "image");
  if (!hasImages) {
    return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
  }

  const blocks = content.map((block) => {
    if (block.type === "text") {
      return { type: "text" as const, text: sanitizeSurrogates(block.text) };
    }
    return {
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: block.mimeType,
        data: block.data,
      },
    };
  });

  if (!blocks.some((b) => b.type === "text")) {
    blocks.unshift({ type: "text" as const, text: "(see attached image)" });
  }
  return blocks;
}

function convertMessages(messages: Message[]) {
  const params: any[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        if (msg.content.trim()) {
          params.push({
            role: "user",
            content: sanitizeSurrogates(msg.content),
          });
        }
      } else {
        const blocks = msg.content.map((item) =>
          item.type === "text"
            ? { type: "text" as const, text: sanitizeSurrogates(item.text) }
            : {
                type: "image" as const,
                source: {
                  type: "base64" as const,
                  media_type: item.mimeType as any,
                  data: item.data,
                },
              },
        );
        if (blocks.length > 0) params.push({ role: "user", content: blocks });
      }
    } else if (msg.role === "assistant") {
      const blocks: any[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text.trim()) {
          blocks.push({ type: "text", text: sanitizeSurrogates(block.text) });
        } else if (block.type === "thinking" && block.thinking.trim()) {
          if ((block as ThinkingContent).thinkingSignature) {
            blocks.push({
              type: "thinking",
              thinking: sanitizeSurrogates(block.thinking),
              signature: (block as ThinkingContent).thinkingSignature,
            });
          } else {
            blocks.push({
              type: "text",
              text: sanitizeSurrogates(block.thinking),
            });
          }
        } else if (block.type === "toolCall") {
          blocks.push({
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.arguments,
          });
        }
      }
      if (blocks.length > 0) params.push({ role: "assistant", content: blocks });
    } else if (msg.role === "toolResult") {
      const toolResults: any[] = [
        {
          type: "tool_result",
          tool_use_id: msg.toolCallId,
          content: convertContentBlocks(msg.content),
          is_error: msg.isError,
        },
      ];

      let j = i + 1;
      while (j < messages.length && messages[j].role === "toolResult") {
        const nextMsg = messages[j] as ToolResultMessage;
        toolResults.push({
          type: "tool_result",
          tool_use_id: nextMsg.toolCallId,
          content: convertContentBlocks(nextMsg.content),
          is_error: nextMsg.isError,
        });
        j++;
      }
      i = j - 1;
      params.push({ role: "user", content: toolResults });
    }
  }

  return repairOrphanToolUses(params);
}

/**
 * Anthropic requires every assistant `tool_use` block to be immediately followed
 * by a user message containing matching `tool_result` blocks (one per id).
 *
 * Sessions can end up with orphan tool_use blocks when an assistant turn fails
 * mid-stream (e.g. the model errors after emitting a tool_use but before pi
 * runs the tool), and the user then sends another message instead of letting
 * the turn be retried. Replaying that history makes the API reject every
 * subsequent request with a 400.
 *
 * To recover gracefully we walk the converted messages and, for any assistant
 * tool_use whose immediate next message isn't a matching tool_result, we
 * synthesize an `is_error: true` tool_result so the conversation stays valid.
 * Real tool_results are never modified.
 */
function repairOrphanToolUses(params: any[]): any[] {
  const repaired: any[] = [];

  for (let i = 0; i < params.length; i++) {
    const msg = params[i];
    repaired.push(msg);

    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    const toolUseIds: string[] = [];
    for (const block of msg.content) {
      if (block?.type === "tool_use" && typeof block.id === "string") {
        toolUseIds.push(block.id);
      }
    }
    if (toolUseIds.length === 0) continue;

    const next = params[i + 1];
    const existingResultIds = new Set<string>();
    if (next && next.role === "user" && Array.isArray(next.content)) {
      for (const block of next.content) {
        if (block?.type === "tool_result" && typeof block.tool_use_id === "string") {
          existingResultIds.add(block.tool_use_id);
        }
      }
    }

    const missingIds = toolUseIds.filter((id) => !existingResultIds.has(id));
    if (missingIds.length === 0) continue;

    const syntheticResults = missingIds.map((id) => ({
      type: "tool_result",
      tool_use_id: id,
      content: "Tool execution was interrupted (no result recorded). The assistant should not assume any side effect occurred and may retry if needed.",
      is_error: true,
    }));

    if (next && next.role === "user" && Array.isArray(next.content)) {
      // Prepend synthetic results so they sit alongside the real ones. Anthropic
      // accepts multiple tool_result blocks in a single user message.
      next.content = [...syntheticResults, ...next.content];
    } else {
      // No following user message at all (or it's another assistant turn).
      // Insert a brand-new user message with just the synthetic results.
      repaired.push({ role: "user", content: syntheticResults });
    }

    if (debugWarningsEnabled()) {
      console.warn(
        `[agent-platform-anthropic] Repaired ${missingIds.length} orphan tool_use id(s): ${missingIds.join(", ")}`,
      );
    }
  }

  return repaired;
}

function convertTools(tools: Tool[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: "object",
      properties: (tool.parameters as any).properties || {},
      required: (tool.parameters as any).required || [],
    },
  }));
}

function applyEphemeralCacheControl(block: any) {
  return { ...block, cache_control: { type: "ephemeral" } };
}

function addPromptCaching(body: any) {
  // Anthropic accepts at most 4 cache_control markers per request.
  // Prefer stable/high-value prefixes first: system prompt, last user turn,
  // then as many tool definitions as fit within the limit.
  let remainingMarkers = 4;

  if (typeof body.system === "string" && remainingMarkers > 0) {
    body.system = [applyEphemeralCacheControl({ type: "text", text: body.system })];
    remainingMarkers--;
  } else if (Array.isArray(body.system) && body.system.length > 0 && remainingMarkers > 0) {
    body.system[body.system.length - 1] = applyEphemeralCacheControl(
      body.system[body.system.length - 1],
    );
    remainingMarkers--;
  }

  for (let i = body.messages.length - 1; i >= 0; i--) {
    const message = body.messages[i];
    if (message.role !== "user") continue;

    if (typeof message.content === "string" && remainingMarkers > 0) {
      message.content = [applyEphemeralCacheControl({ type: "text", text: message.content })];
      remainingMarkers--;
    } else if (
      Array.isArray(message.content) &&
      message.content.length > 0 &&
      remainingMarkers > 0
    ) {
      message.content[message.content.length - 1] = applyEphemeralCacheControl(
        message.content[message.content.length - 1],
      );
      remainingMarkers--;
    }
    break;
  }

  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (remainingMarkers <= 0) break;
      tool.cache_control = { type: "ephemeral" };
      remainingMarkers--;
    }
  }
}

function resolveAccessToken(): string {
  const envToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN || process.env.AGENT_PLATFORM_ACCESS_TOKEN;
  if (envToken?.trim()) return envToken.trim();

  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now()) {
    return cachedAccessToken.value;
  }

  let token: string;
  try {
    token = execFileSync("gcloud", ["auth", "application-default", "print-access-token"], {
      encoding: "utf8",
    }).trim();
  } catch (error) {
    throw new Error(
      `Could not resolve a Google access token from Application Default Credentials. Run "gcloud auth application-default login". ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!token) {
    throw new Error(
      'Could not resolve a Google access token from Application Default Credentials. Run "gcloud auth application-default login".',
    );
  }

  cachedAccessToken = { value: token, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS };
  return token;
}

function normalizeBaseUrl(baseUrl: string): string {
  let normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized)
    throw new Error(
      "Gemini Enterprise Agent Platform Anthropic base URL resolved to an empty string.",
    );
  if (!/\/v\d+(?:beta\d+)?$/i.test(normalized)) {
    normalized = `${normalized}/v1`;
  }
  return normalized;
}

function looksLikeMultiRegion(location: string): boolean {
  const normalized = location.trim().toLowerCase();
  return normalized === "global" || /^[a-z]{2}$/.test(normalized);
}

function inferMultiLocationFromBaseUrl(baseUrl: string | undefined): string | undefined {
  if (!baseUrl?.trim()) return undefined;
  try {
    const candidate = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
    const host = new URL(candidate).hostname.toLowerCase();
    if (host === "aiplatform.googleapis.com") return "global";
    const repHostMatch = host.match(/^aiplatform\.([a-z0-9-]+)\.rep\.googleapis\.com$/i);
    if (repHostMatch?.[1]) return repHostMatch[1].toLowerCase();
  } catch {
    return undefined;
  }
  return undefined;
}

function inferMultiLocationFromRegionalLocation(
  regionalLocation: string | undefined,
): string | undefined {
  const normalized = regionalLocation?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized.startsWith("europe-")) return "eu";
  if (normalized.startsWith("us-")) return "us";
  return undefined;
}

function resolveRegionalLocation(): string {
  const explicitRegionalLocation =
    process.env.AGENT_PLATFORM_ANTHROPIC_REGIONAL_LOCATION?.trim() ||
    process.env.GOOGLE_AGENT_PLATFORM_LOCATION?.trim() ||
    process.env.GOOGLE_CLOUD_LOCATION?.trim();
  if (explicitRegionalLocation) return explicitRegionalLocation;

  return DEFAULT_LOCATION;
}

function resolveMultiRegionProfile(): AgentPlatformEndpointProfile | undefined {
  const baseUrlFromEnv =
    process.env.ANTHROPIC_AGENT_PLATFORM_BASE_URL?.trim() ||
    process.env.AGENT_PLATFORM_ANTHROPIC_BASE_URL?.trim();
  const locationFromEnv =
    process.env.AGENT_PLATFORM_ANTHROPIC_MULTI_LOCATION?.trim() ||
    process.env.ANTHROPIC_AGENT_PLATFORM_LOCATION?.trim();
  const regionalLocation =
    process.env.AGENT_PLATFORM_ANTHROPIC_REGIONAL_LOCATION?.trim() ||
    process.env.GOOGLE_AGENT_PLATFORM_LOCATION?.trim() ||
    process.env.GOOGLE_CLOUD_LOCATION?.trim();

  const locationFromBaseUrl = inferMultiLocationFromBaseUrl(baseUrlFromEnv);
  const locationFromRegionalFallback = inferMultiLocationFromRegionalLocation(regionalLocation);

  const location =
    locationFromBaseUrl ||
    locationFromEnv ||
    locationFromRegionalFallback ||
    DEFAULT_MULTI_LOCATION;
  if (!location) {
    return undefined;
  }
  if (!looksLikeMultiRegion(location)) {
    return undefined;
  }

  const inferredBaseUrl =
    baseUrlFromEnv ||
    (location.toLowerCase() === "global"
      ? "https://aiplatform.googleapis.com"
      : `https://aiplatform.${location}.rep.googleapis.com`);

  return {
    name: "multi",
    baseUrl: normalizeBaseUrl(inferredBaseUrl),
    location,
  };
}

function resolveEndpointProfiles(): Record<
  EndpointProfileName,
  AgentPlatformEndpointProfile | undefined
> {
  const regionalLocation = resolveRegionalLocation();
  return {
    regional: {
      name: "regional",
      baseUrl: normalizeBaseUrl(`https://${regionalLocation}-aiplatform.googleapis.com`),
      location: regionalLocation,
    },
    multi: resolveMultiRegionProfile(),
  };
}

function normalizeEndpointProfileName(value: string): EndpointProfileName | undefined {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;

  if (["regional", "region", "default", "europe", "europe-west1"].includes(normalized)) {
    return "regional";
  }
  if (["multi", "multiregion", "multi-region", "rep", "global", "eu", "us"].includes(normalized)) {
    return "multi";
  }
  return undefined;
}

function parseDelimitedEntries(raw: string): string[] {
  return raw
    .split(/[;,]/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseModelEndpointOverrides(): Record<string, EndpointProfileName[]> {
  const raw = process.env.AGENT_PLATFORM_ANTHROPIC_MODEL_ENDPOINTS?.trim();
  if (!raw) return {};

  const overrides: Record<string, EndpointProfileName[]> = {};

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<string, string | string[]>;
      for (const [modelIdRaw, endpointList] of Object.entries(parsed)) {
        const modelId = modelIdRaw.trim();
        if (!modelId) continue;
        const values = Array.isArray(endpointList)
          ? endpointList.map((v) => String(v))
          : String(endpointList).split(/[|>,]/g);
        const endpointNames = dedupe(
          values
            .map((value) => normalizeEndpointProfileName(value))
            .filter(Boolean) as EndpointProfileName[],
        );
        if (endpointNames.length) overrides[modelId] = endpointNames;
      }
      return overrides;
    } catch {
      // Fall back to shorthand parser below.
    }
  }

  for (const entry of parseDelimitedEntries(raw)) {
    const [modelIdRaw, endpointListRaw] = entry.split("=");
    const modelId = modelIdRaw?.trim();
    if (!modelId || !endpointListRaw) continue;

    const endpointNames = dedupe(
      endpointListRaw
        .split(/[|>]/g)
        .map((value) => normalizeEndpointProfileName(value))
        .filter(Boolean) as EndpointProfileName[],
    );
    if (endpointNames.length) {
      overrides[modelId] = endpointNames;
    }
  }

  return overrides;
}

function parseModelLimitsOverrides(): Record<string, ModelLimitsOverride> {
  const raw = process.env.AGENT_PLATFORM_ANTHROPIC_MODEL_LIMITS?.trim();
  if (!raw) return {};

  const overrides: Record<string, ModelLimitsOverride> = {};

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as Record<
        string,
        { contextWindow?: unknown; maxTokens?: unknown }
      >;
      for (const [modelIdRaw, limits] of Object.entries(parsed)) {
        const modelId = modelIdRaw.trim();
        if (!modelId) continue;

        const contextWindow = parsePositiveInt(limits?.contextWindow);
        const maxTokens = parsePositiveInt(limits?.maxTokens);
        if (contextWindow || maxTokens) {
          overrides[modelId] = {
            ...(contextWindow ? { contextWindow } : {}),
            ...(maxTokens ? { maxTokens } : {}),
          };
        }
      }
      return overrides;
    } catch {
      // Fall back to shorthand parser below.
    }
  }

  for (const entry of parseDelimitedEntries(raw)) {
    const [modelIdRaw, limitsRaw] = entry.split("=");
    const modelId = modelIdRaw?.trim();
    if (!modelId || !limitsRaw) continue;

    const [contextRaw, maxRaw] = limitsRaw.split(/[:/]/g).map((value) => value.trim());
    const contextWindow = parsePositiveInt(contextRaw);
    const maxTokens = parsePositiveInt(maxRaw);
    if (contextWindow || maxTokens) {
      overrides[modelId] = {
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxTokens ? { maxTokens } : {}),
      };
    }
  }

  return overrides;
}

function resolveModelLimits(
  modelId: string,
  overrides: Record<string, ModelLimitsOverride>,
): ModelLimits {
  const defaults =
    DEFAULT_MODEL_LIMITS[modelId] ||
    (isOneMillionModelAlias(modelId)
      ? {
          contextWindow: ONE_MILLION_CONTEXT_WINDOW,
          maxTokens: DEFAULT_MAX_TOKENS,
        }
      : {
          contextWindow: DEFAULT_CONTEXT_WINDOW,
          maxTokens: DEFAULT_MAX_TOKENS,
        });

  const override = overrides[modelId];
  if (!override) return defaults;

  return {
    contextWindow: override.contextWindow ?? defaults.contextWindow,
    maxTokens: override.maxTokens ?? defaults.maxTokens,
  };
}

function resolveEndpointOrderForModel(
  modelId: string,
  endpointProfiles: Record<EndpointProfileName, AgentPlatformEndpointProfile | undefined>,
  endpointOverrides: Record<string, EndpointProfileName[]>,
): AgentPlatformEndpointProfile[] {
  const overrideOrder = endpointOverrides[modelId];
  if (overrideOrder?.length) {
    const overrideProfiles = dedupe(overrideOrder)
      .map((name) => endpointProfiles[name])
      .filter(Boolean) as AgentPlatformEndpointProfile[];
    if (overrideProfiles.length) return overrideProfiles;
  }

  const defaultOrder =
    DEFAULT_MODEL_ENDPOINT_ORDER[modelId] ||
    (isOneMillionModelAlias(modelId) ? ["multi"] : ["multi", "regional"]);

  const defaultProfiles = dedupe(defaultOrder)
    .map((name) => endpointProfiles[name])
    .filter(Boolean) as AgentPlatformEndpointProfile[];
  if (defaultProfiles.length) return defaultProfiles;

  if (isOneMillionModelAlias(modelId)) {
    const multiProfile = endpointProfiles.multi;
    return multiProfile ? [multiProfile] : [];
  }

  return (["multi", "regional"] as EndpointProfileName[])
    .map((name) => endpointProfiles[name])
    .filter(Boolean) as AgentPlatformEndpointProfile[];
}

function buildAgentPlatformStreamUrl(
  endpoint: AgentPlatformEndpointProfile,
  project: string,
  modelId: string,
): string {
  const encodedModelId = encodeURIComponent(modelId);
  return `${endpoint.baseUrl}/projects/${project}/locations/${endpoint.location}/publishers/anthropic/models/${encodedModelId}:streamRawPredict`;
}

function isRetryableAtNextEndpoint(status: number, bodyText: string): boolean {
  if (status === 404 || status === 429) return true;
  if (status !== 400 && status !== 403) return false;

  const text = bodyText.toLowerCase();
  return (
    text.includes("not found") ||
    text.includes("resource not found") ||
    text.includes("publisher model") ||
    text.includes("invalid publisher") ||
    text.includes("invalid endpoint name") ||
    (text.includes("model") && text.includes("location") && text.includes("supported"))
  );
}

function parseAdaptiveThinkingModelIds(): Set<string> {
  const raw = process.env.AGENT_PLATFORM_ANTHROPIC_ADAPTIVE_MODELS?.trim();
  const modelIds = raw
    ? raw
        .split(",")
        .map((modelId) => modelId.trim())
        .filter(Boolean)
    : ["claude-opus-4-7"];

  return new Set(modelIds.map((modelId) => resolveAgentPlatformRequestModelId(modelId)));
}

const ADAPTIVE_THINKING_MODEL_IDS = parseAdaptiveThinkingModelIds();

function usesAdaptiveThinking(modelId: string): boolean {
  return ADAPTIVE_THINKING_MODEL_IDS.has(resolveAgentPlatformRequestModelId(modelId));
}

function mapReasoningEffort(reasoning: string): AdaptiveThinkingEffort {
  return ADAPTIVE_THINKING_LEVEL_MAP[reasoning] ?? "medium";
}

function resolveProjectId(): string {
  const project =
    process.env.GOOGLE_CLOUD_PROJECT?.trim() ||
    process.env.GOOGLE_AGENT_PLATFORM_PROJECT?.trim() ||
    process.env.AGENT_PLATFORM_PROJECT_ID?.trim() ||
    process.env.ANTHROPIC_AGENT_PLATFORM_PROJECT_ID?.trim();

  if (project) return project;

  throw new Error(`Missing Google Cloud project for Gemini Enterprise Agent Platform.

Run:
  export GOOGLE_CLOUD_PROJECT="your-project-id"
  gcloud auth application-default login

Advanced aliases also supported:
  GOOGLE_AGENT_PLATFORM_PROJECT
  AGENT_PLATFORM_PROJECT_ID
  ANTHROPIC_AGENT_PLATFORM_PROJECT_ID`);
}

async function postAgentPlatformStreamWithFallback(
  endpoints: AgentPlatformEndpointProfile[],
  params: {
    project: string;
    modelId: string;
    token: string;
    body: unknown;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const attempts: string[] = [];

  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i];
    const endpointLabel = `${endpoint.name}:${endpoint.location}`;
    const url = buildAgentPlatformStreamUrl(endpoint, params.project, params.modelId);

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${params.token}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify(params.body),
        signal: params.signal,
      });
    } catch (error) {
      if (params.signal?.aborted) throw error;
      attempts.push(
        `${endpointLabel} -> network error: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (i < endpoints.length - 1) continue;
      break;
    }

    if (response.ok && response.body) {
      return response;
    }

    const text = await response.text();
    attempts.push(`${endpointLabel} -> ${response.status} ${text}`);

    const canTryNextEndpoint =
      i < endpoints.length - 1 && isRetryableAtNextEndpoint(response.status, text);
    if (canTryNextEndpoint) continue;
    break;
  }

  const details = attempts.length
    ? attempts.join("\n---\n")
    : "No endpoint attempts were recorded.";
  throw new Error(
    `Gemini Enterprise Agent Platform Anthropic request failed across endpoints:\n${details}`,
  );
}

function streamAgentPlatformAnthropic(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  runtimeConfig: RuntimeConfig,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };

    try {
      const project = resolveProjectId();

      const endpoints = resolveEndpointOrderForModel(
        model.id,
        runtimeConfig.endpointProfiles,
        runtimeConfig.endpointOverrides,
      );
      if (endpoints.length === 0) {
        if (isOneMillionModelAlias(model.id)) {
          const baseUrlHint =
            process.env.ANTHROPIC_AGENT_PLATFORM_BASE_URL?.trim() ||
            process.env.AGENT_PLATFORM_ANTHROPIC_BASE_URL?.trim() ||
            "(unset)";
          const multiLocationHint =
            process.env.AGENT_PLATFORM_ANTHROPIC_MULTI_LOCATION?.trim() ||
            process.env.ANTHROPIC_AGENT_PLATFORM_LOCATION?.trim() ||
            "(unset)";
          const regionalLocationHint =
            process.env.GOOGLE_AGENT_PLATFORM_LOCATION?.trim() ||
            process.env.GOOGLE_CLOUD_LOCATION?.trim() ||
            process.env.AGENT_PLATFORM_ANTHROPIC_REGIONAL_LOCATION?.trim() ||
            "(unset)";
          throw new Error(
            `Model requires a multi-region endpoint. Set ANTHROPIC_AGENT_PLATFORM_BASE_URL (for example https://aiplatform.eu.rep.googleapis.com/v1) and AGENT_PLATFORM_ANTHROPIC_MULTI_LOCATION (eu, us, or global). Detected env: base URL=${baseUrlHint}, multi location=${multiLocationHint}, regional location=${regionalLocationHint}.`,
          );
        }
        throw new Error(
          "No Gemini Enterprise Agent Platform endpoint profiles are configured for this model.",
        );
      }

      const token = resolveAccessToken();
      const requestModelId = resolveAgentPlatformRequestModelId(model.id);
      const maxTokens = options?.maxTokens || Math.floor(model.maxTokens / 3);

      const body: any = {
        anthropic_version: ANTHROPIC_VERSION,
        messages: convertMessages(context.messages),
        max_tokens: maxTokens,
        stream: true,
      };
      if (context.systemPrompt) body.system = sanitizeSurrogates(context.systemPrompt);
      if (context.tools?.length) body.tools = convertTools(context.tools);
      addPromptCaching(body);

      if (options?.reasoning && model.reasoning) {
        if (usesAdaptiveThinking(model.id)) {
          body.thinking = { type: "adaptive" };
          body.output_config = { effort: mapReasoningEffort(options.reasoning) };
        } else {
          const defaultBudgets: Record<string, number> = {
            minimal: 1024,
            low: 4096,
            medium: 10240,
            high: 20480,
            xhigh: 65536,
          };
          const customBudget =
            options.thinkingBudgets?.[options.reasoning as keyof typeof options.thinkingBudgets];
          body.thinking = {
            type: "enabled",
            budget_tokens: customBudget ?? defaultBudgets[options.reasoning] ?? 10240,
          };
        }
      }

      const response = await postAgentPlatformStreamWithFallback(endpoints, {
        project,
        modelId: requestModelId,
        token,
        body,
        signal: options?.signal,
      });
      const responseBody = response.body;
      if (!responseBody) {
        throw new Error(
          "Gemini Enterprise Agent Platform Anthropic response did not include a stream body.",
        );
      }

      stream.push({ type: "start", partial: output });

      type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & {
        index: number;
      };
      const blocks = output.content as Block[];

      const reader = responseBody.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const handleEvent = (event: any) => {
        if (!event?.type) return;

        if (event.type === "message_start") {
          output.usage.input = event.message?.usage?.input_tokens || 0;
          output.usage.output = event.message?.usage?.output_tokens || 0;
          output.usage.cacheRead = event.message?.usage?.cache_read_input_tokens || 0;
          output.usage.cacheWrite = event.message?.usage?.cache_creation_input_tokens || 0;
          output.usage.totalTokens =
            output.usage.input +
            output.usage.output +
            output.usage.cacheRead +
            output.usage.cacheWrite;
          calculateCost(model, output.usage);
        } else if (event.type === "content_block_start") {
          if (event.content_block?.type === "text") {
            output.content.push({
              type: "text",
              text: "",
              index: event.index,
            } as any);
            stream.push({
              type: "text_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (event.content_block?.type === "thinking") {
            output.content.push({
              type: "thinking",
              thinking: "",
              thinkingSignature: "",
              index: event.index,
            } as any);
            stream.push({
              type: "thinking_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          } else if (event.content_block?.type === "tool_use") {
            output.content.push({
              type: "toolCall",
              id: event.content_block.id,
              name: event.content_block.name,
              arguments: {},
              partialJson: "",
              index: event.index,
            } as any);
            stream.push({
              type: "toolcall_start",
              contentIndex: output.content.length - 1,
              partial: output,
            });
          }
        } else if (event.type === "content_block_delta") {
          const index = blocks.findIndex((b) => b.index === event.index);
          const block = blocks[index];
          if (!block) return;

          if (event.delta?.type === "text_delta" && block.type === "text") {
            block.text += event.delta.text;
            stream.push({
              type: "text_delta",
              contentIndex: index,
              delta: event.delta.text,
              partial: output,
            });
          } else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
            block.thinking += event.delta.thinking;
            stream.push({
              type: "thinking_delta",
              contentIndex: index,
              delta: event.delta.thinking,
              partial: output,
            });
          } else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
            (block as any).partialJson += event.delta.partial_json;
            // Parse progressively for partial UI updates; parse again at block end for final state.
            try {
              block.arguments = JSON.parse((block as any).partialJson);
            } catch {}
            stream.push({
              type: "toolcall_delta",
              contentIndex: index,
              delta: event.delta.partial_json,
              partial: output,
            });
          } else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
            block.thinkingSignature = (block.thinkingSignature || "") + event.delta.signature;
          }
        } else if (event.type === "content_block_stop") {
          const index = blocks.findIndex((b) => b.index === event.index);
          const block = blocks[index];
          if (!block) return;

          delete (block as any).index;
          if (block.type === "text") {
            stream.push({
              type: "text_end",
              contentIndex: index,
              content: block.text,
              partial: output,
            });
          } else if (block.type === "thinking") {
            stream.push({
              type: "thinking_end",
              contentIndex: index,
              content: block.thinking,
              partial: output,
            });
          } else if (block.type === "toolCall") {
            try {
              block.arguments = JSON.parse((block as any).partialJson);
            } catch {}
            delete (block as any).partialJson;
            stream.push({
              type: "toolcall_end",
              contentIndex: index,
              toolCall: block,
              partial: output,
            });
          }
        } else if (event.type === "message_delta") {
          if (event.delta?.stop_reason) output.stopReason = mapStopReason(event.delta.stop_reason);
          output.usage.input = event.usage?.input_tokens || output.usage.input;
          output.usage.output = event.usage?.output_tokens || output.usage.output;
          output.usage.cacheRead = event.usage?.cache_read_input_tokens || output.usage.cacheRead;
          output.usage.cacheWrite =
            event.usage?.cache_creation_input_tokens || output.usage.cacheWrite;
          output.usage.totalTokens =
            output.usage.input +
            output.usage.output +
            output.usage.cacheRead +
            output.usage.cacheWrite;
          calculateCost(model, output.usage);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex !== -1) {
          const rawLine = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          const line = rawLine.trim();

          if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            if (data && data !== "[DONE]") {
              const parsed = parseStreamJson(data);
              if (parsed) handleEvent(parsed);
            }
          } else if (line.startsWith("{")) {
            const parsed = parseStreamJson(line);
            if (parsed) handleEvent(parsed);
          }

          newlineIndex = buffer.indexOf("\n");
        }
      }

      if (options?.signal?.aborted) throw new Error("Request was aborted");

      stream.push({
        type: "done",
        reason: output.stopReason as "stop" | "length" | "toolUse",
        message: output,
      });
      stream.end();
    } catch (error) {
      for (const block of output.content) delete (block as any).index;
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

function parseModelListFromEnv(): string[] {
  const explicitList = process.env.AGENT_PLATFORM_ANTHROPIC_MODELS?.trim();
  if (explicitList) {
    return dedupe(
      explicitList
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
    );
  }

  const anthropicDefaults = dedupe(
    [
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      process.env.ANTHROPIC_SMALL_FAST_MODEL,
    ]
      .map((m) => m?.trim())
      .filter(Boolean) as string[],
  );

  return dedupe([...anthropicDefaults, ...DEFAULT_MODELS]);
}

export default function (pi: ExtensionAPI) {
  pi.on("message_end", (event: any, ctx: any) => {
    const message = event.message;
    if (message?.role !== "assistant") return;
    if (message.stopReason !== "error") return;
    if (
      message.provider !== "agent-platform-anthropic" &&
      ctx.model?.provider !== "agent-platform-anthropic"
    )
      return;

    const errorMessage = message.errorMessage ?? "";
    if (errorMessage.includes("context_length_exceeded")) return;
    if (!AGENT_PLATFORM_OVERFLOW_PATTERN.test(errorMessage)) return;

    return {
      message: {
        ...message,
        errorMessage: `context_length_exceeded: ${errorMessage}`,
      },
    };
  });

  const modelIds = parseModelListFromEnv();
  const modelLimitsOverrides = parseModelLimitsOverrides();

  const runtimeConfig: RuntimeConfig = {
    endpointProfiles: resolveEndpointProfiles(),
    endpointOverrides: parseModelEndpointOverrides(),
  };

  const models = modelIds.map((id) => {
    const limits = resolveModelLimits(id, modelLimitsOverrides);
    return {
      id,
      name: resolveModelDisplayName(id),
      reasoning: true,
      thinkingLevelMap: usesAdaptiveThinking(id) ? ADAPTIVE_THINKING_LEVEL_MAP : undefined,
      input: ["text", "image"],
      cost: resolveModelCost(id),
      contextWindow: limits.contextWindow,
      maxTokens: limits.maxTokens,
    };
  });

  const streamSimple = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
    streamAgentPlatformAnthropic(model, context, options, runtimeConfig);

  pi.registerProvider("agent-platform-anthropic", {
    name: "Gemini Enterprise Agent Platform Anthropic",
    // Dummy apiKey keeps provider selectable; actual auth comes from ADC via gcloud token retrieval.
    apiKey: "agent-platform-adc",
    api: "agent-platform-anthropic-api",
    baseUrl: "https://aiplatform.googleapis.com/v1",
    models,
    streamSimple,
  });
}

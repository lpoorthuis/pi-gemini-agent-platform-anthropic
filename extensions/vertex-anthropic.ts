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
} from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const DEFAULT_LOCATION = "europe-west1";
const DEFAULT_MULTI_LOCATION = "global";
const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 64000;
const ONE_MILLION_CONTEXT_WINDOW = 1000000;

const DEFAULT_MODELS = [
	"claude-opus-4-7",
	"claude-opus-4-7[1m]",
	"claude-opus-4-6",
	"claude-sonnet-4-6",
	"claude-haiku-4-5@20251001",
];

type EndpointProfileName = "regional" | "multi";

interface VertexEndpointProfile {
	name: EndpointProfileName;
	baseUrl: string;
	location: string;
}

interface ModelLimits {
	contextWindow: number;
	maxTokens: number;
}

type ModelLimitsOverride = Partial<ModelLimits>;

interface RuntimeConfig {
	endpointProfiles: Record<EndpointProfileName, VertexEndpointProfile | undefined>;
	endpointOverrides: Record<string, EndpointProfileName[]>;
}

const DEFAULT_MODEL_LIMITS: Record<string, ModelLimits> = {
	"claude-opus-4-7": { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
	"claude-opus-4-7[1m]": { contextWindow: ONE_MILLION_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
	"claude-opus-4-6": { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
	"claude-sonnet-4-6": { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
	"claude-haiku-4-5@20251001": { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS },
};

const DEFAULT_MODEL_ENDPOINT_ORDER: Record<string, EndpointProfileName[]> = {
	"claude-opus-4-7": ["regional", "multi"],
	"claude-opus-4-7[1m]": ["multi", "regional"],
	"claude-opus-4-6": ["regional", "multi"],
	"claude-sonnet-4-6": ["regional", "multi"],
	"claude-haiku-4-5@20251001": ["regional", "multi"],
};

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
					params.push({ role: "user", content: sanitizeSurrogates(msg.content) });
				}
			} else {
				const blocks = msg.content.map((item) =>
					item.type === "text"
						? { type: "text" as const, text: sanitizeSurrogates(item.text) }
						: {
								type: "image" as const,
								source: { type: "base64" as const, media_type: item.mimeType as any, data: item.data },
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
					blocks.push({ type: "text", text: sanitizeSurrogates(block.thinking) });
				} else if (block.type === "toolCall") {
					blocks.push({ type: "tool_use", id: block.id, name: block.name, input: block.arguments });
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

	return params;
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

function resolveAccessToken(): string {
	const envToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN || process.env.VERTEX_ACCESS_TOKEN;
	if (envToken?.trim()) return envToken.trim();

	const token = execFileSync("gcloud", ["auth", "application-default", "print-access-token"], {
		encoding: "utf8",
	}).trim();
	if (!token) throw new Error("Could not resolve a Google access token from ADC.");
	return token;
}

function normalizeBaseUrl(baseUrl: string): string {
	let normalized = baseUrl.trim().replace(/\/+$/, "");
	if (!normalized) throw new Error("ANTHROPIC_VERTEX_BASE_URL resolved to an empty string.");
	if (!/\/v\d+(?:beta\d+)?$/i.test(normalized)) {
		normalized = `${normalized}/v1`;
	}
	return normalized;
}

function looksLikeMultiRegion(location: string): boolean {
	const normalized = location.trim().toLowerCase();
	return normalized === "global" || /^[a-z]{2}$/.test(normalized);
}

function resolveRegionalLocation(): string {
	const explicitRegionalLocation =
		process.env.VERTEX_ANTHROPIC_REGIONAL_LOCATION?.trim() || process.env.GOOGLE_CLOUD_LOCATION?.trim();
	if (explicitRegionalLocation) return explicitRegionalLocation;

	const cloudMlRegion = process.env.CLOUD_ML_REGION?.trim();
	const hasExplicitMultiBaseUrl = Boolean(process.env.ANTHROPIC_VERTEX_BASE_URL?.trim());
	if (cloudMlRegion && !hasExplicitMultiBaseUrl && !looksLikeMultiRegion(cloudMlRegion)) {
		return cloudMlRegion;
	}

	return DEFAULT_LOCATION;
}

function resolveMultiRegionProfile(): VertexEndpointProfile | undefined {
	const baseUrlFromEnv = process.env.ANTHROPIC_VERTEX_BASE_URL?.trim();
	const locationFromEnv = process.env.CLOUD_ML_REGION?.trim() || process.env.VERTEX_ANTHROPIC_MULTI_LOCATION?.trim();

	if (!baseUrlFromEnv && !locationFromEnv) {
		return undefined;
	}

	if (!baseUrlFromEnv && locationFromEnv && !looksLikeMultiRegion(locationFromEnv)) {
		return undefined;
	}

	const location = locationFromEnv || DEFAULT_MULTI_LOCATION;
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

function resolveEndpointProfiles(): Record<EndpointProfileName, VertexEndpointProfile | undefined> {
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
	const raw = process.env.VERTEX_ANTHROPIC_MODEL_ENDPOINTS?.trim();
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
	const raw = process.env.VERTEX_ANTHROPIC_MODEL_LIMITS?.trim();
	if (!raw) return {};

	const overrides: Record<string, ModelLimitsOverride> = {};

	if (raw.startsWith("{")) {
		try {
			const parsed = JSON.parse(raw) as Record<string, { contextWindow?: unknown; maxTokens?: unknown }>;
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

function resolveModelLimits(modelId: string, overrides: Record<string, ModelLimitsOverride>): ModelLimits {
	const defaults =
		DEFAULT_MODEL_LIMITS[modelId] ||
		(/\[1m\]/i.test(modelId)
			? { contextWindow: ONE_MILLION_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS }
			: { contextWindow: DEFAULT_CONTEXT_WINDOW, maxTokens: DEFAULT_MAX_TOKENS });

	const override = overrides[modelId];
	if (!override) return defaults;

	return {
		contextWindow: override.contextWindow ?? defaults.contextWindow,
		maxTokens: override.maxTokens ?? defaults.maxTokens,
	};
}

function resolveEndpointOrderForModel(
	modelId: string,
	endpointProfiles: Record<EndpointProfileName, VertexEndpointProfile | undefined>,
	endpointOverrides: Record<string, EndpointProfileName[]>,
): VertexEndpointProfile[] {
	const overrideOrder = endpointOverrides[modelId];
	if (overrideOrder?.length) {
		const overrideProfiles = dedupe(overrideOrder)
			.map((name) => endpointProfiles[name])
			.filter(Boolean) as VertexEndpointProfile[];
		if (overrideProfiles.length) return overrideProfiles;
	}

	const defaultOrder =
		DEFAULT_MODEL_ENDPOINT_ORDER[modelId] || (/\[1m\]/i.test(modelId) ? ["multi", "regional"] : ["regional", "multi"]);

	const defaultProfiles = dedupe(defaultOrder)
		.map((name) => endpointProfiles[name])
		.filter(Boolean) as VertexEndpointProfile[];
	if (defaultProfiles.length) return defaultProfiles;

	return (["regional", "multi"] as EndpointProfileName[])
		.map((name) => endpointProfiles[name])
		.filter(Boolean) as VertexEndpointProfile[];
}

function buildVertexStreamUrl(endpoint: VertexEndpointProfile, project: string, modelId: string): string {
	const encodedModelId = encodeURIComponent(modelId);
	return `${endpoint.baseUrl}/projects/${project}/locations/${endpoint.location}/publishers/anthropic/models/${encodedModelId}:streamRawPredict`;
}

function isModelUnavailableAtEndpoint(status: number, bodyText: string): boolean {
	if (status === 404) return true;
	if (status !== 400 && status !== 403) return false;

	const text = bodyText.toLowerCase();
	return (
		text.includes("not found") ||
		text.includes("resource not found") ||
		text.includes("publisher model") ||
		text.includes("invalid publisher") ||
		(text.includes("model") && text.includes("location") && text.includes("supported"))
	);
}

async function postVertexStreamWithFallback(
	endpoints: VertexEndpointProfile[],
	params: {
		project: string;
		modelId: string;
		token: string;
		body: unknown;
		signal?: AbortSignal;
	},
): Promise<Response> {
	let lastError = "";

	for (let i = 0; i < endpoints.length; i++) {
		const endpoint = endpoints[i];
		const url = buildVertexStreamUrl(endpoint, params.project, params.modelId);

		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${params.token}`,
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				},
				body: JSON.stringify(params.body),
				signal: params.signal,
			});

			if (response.ok && response.body) {
				return response;
			}

			const text = await response.text();
			const endpointLabel = `${endpoint.name}:${endpoint.location}`;
			lastError = `Vertex Anthropic request failed (${endpointLabel}): ${response.status} ${text}`;

			const canTryNextEndpoint = i < endpoints.length - 1 && isModelUnavailableAtEndpoint(response.status, text);
			if (canTryNextEndpoint) continue;

			throw new Error(lastError);
		} catch (error) {
			if (params.signal?.aborted) throw error;

			const canTryNextEndpoint = i < endpoints.length - 1;
			if (!canTryNextEndpoint) throw error;

			lastError = error instanceof Error ? error.message : String(error);
		}
	}

	throw new Error(lastError || "Vertex Anthropic request failed.");
}

function streamVertexAnthropic(
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
			const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.ANTHROPIC_VERTEX_PROJECT_ID;
			if (!project) {
				throw new Error("Set GOOGLE_CLOUD_PROJECT (or ANTHROPIC_VERTEX_PROJECT_ID) for Vertex Anthropic.");
			}

			const endpoints = resolveEndpointOrderForModel(
				model.id,
				runtimeConfig.endpointProfiles,
				runtimeConfig.endpointOverrides,
			);
			if (endpoints.length === 0) {
				throw new Error("No Vertex endpoint profiles are configured for this model.");
			}

			const token = resolveAccessToken();
			const maxTokens = options?.maxTokens || Math.floor(model.maxTokens / 3);

			const body: any = {
				anthropic_version: "vertex-2023-10-16",
				messages: convertMessages(context.messages),
				max_tokens: maxTokens,
				stream: true,
			};
			if (context.systemPrompt) body.system = sanitizeSurrogates(context.systemPrompt);
			if (context.tools?.length) body.tools = convertTools(context.tools);

			if (options?.reasoning && model.reasoning) {
				const defaultBudgets: Record<string, number> = { minimal: 1024, low: 4096, medium: 10240, high: 20480 };
				const customBudget = options.thinkingBudgets?.[options.reasoning as keyof typeof options.thinkingBudgets];
				body.thinking = {
					type: "enabled",
					budget_tokens: customBudget ?? defaultBudgets[options.reasoning] ?? 10240,
				};
			}

			const response = await postVertexStreamWithFallback(endpoints, {
				project,
				modelId: model.id,
				token,
				body,
				signal: options?.signal,
			});
			const responseBody = response.body;
			if (!responseBody) {
				throw new Error("Vertex Anthropic response did not include a stream body.");
			}

			stream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
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
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				} else if (event.type === "content_block_start") {
					if (event.content_block?.type === "text") {
						output.content.push({ type: "text", text: "", index: event.index } as any);
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block?.type === "thinking") {
						output.content.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index } as any);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block?.type === "tool_use") {
						output.content.push({
							type: "toolCall",
							id: event.content_block.id,
							name: event.content_block.name,
							arguments: {},
							partialJson: "",
							index: event.index,
						} as any);
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
				} else if (event.type === "content_block_delta") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (!block) return;

					if (event.delta?.type === "text_delta" && block.type === "text") {
						block.text += event.delta.text;
						stream.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: output });
					} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
						block.thinking += event.delta.thinking;
						stream.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: output });
					} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
						(block as any).partialJson += event.delta.partial_json;
						try {
							block.arguments = JSON.parse((block as any).partialJson);
						} catch {}
						stream.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: output });
					} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
						block.thinkingSignature = (block.thinkingSignature || "") + event.delta.signature;
					}
				} else if (event.type === "content_block_stop") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (!block) return;

					delete (block as any).index;
					if (block.type === "text") {
						stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
					} else if (block.type === "thinking") {
						stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
					} else if (block.type === "toolCall") {
						try {
							block.arguments = JSON.parse((block as any).partialJson);
						} catch {}
						delete (block as any).partialJson;
						stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
					}
				} else if (event.type === "message_delta") {
					if (event.delta?.stop_reason) output.stopReason = mapStopReason(event.delta.stop_reason);
					output.usage.input = event.usage?.input_tokens || output.usage.input;
					output.usage.output = event.usage?.output_tokens || output.usage.output;
					output.usage.cacheRead = event.usage?.cache_read_input_tokens || output.usage.cacheRead;
					output.usage.cacheWrite = event.usage?.cache_creation_input_tokens || output.usage.cacheWrite;
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
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
							try {
								handleEvent(JSON.parse(data));
							} catch {}
						}
					} else if (line.startsWith("{")) {
						try {
							handleEvent(JSON.parse(line));
						} catch {}
					}

					newlineIndex = buffer.indexOf("\n");
				}
			}

			if (options?.signal?.aborted) throw new Error("Request was aborted");

			stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
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
	const explicitList = process.env.VERTEX_ANTHROPIC_MODELS?.trim();
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
	const modelIds = parseModelListFromEnv();
	const modelLimitsOverrides = parseModelLimitsOverrides();

	const runtimeConfig: RuntimeConfig = {
		endpointProfiles: resolveEndpointProfiles(),
		endpointOverrides: parseModelEndpointOverrides(),
	};

	pi.registerProvider("vertex-anthropic", {
		// Dummy apiKey keeps provider selectable; actual auth comes from ADC via gcloud token retrieval.
		apiKey: "vertex-adc",
		api: "vertex-anthropic-api",
		baseUrl: "https://aiplatform.googleapis.com/v1",
		models: modelIds.map((id) => {
			const limits = resolveModelLimits(id, modelLimitsOverrides);
			return {
				id,
				name: `Vertex Anthropic: ${id}`,
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: limits.contextWindow,
				maxTokens: limits.maxTokens,
			};
		}),
		streamSimple: (model, context, options) => streamVertexAnthropic(model, context, options, runtimeConfig),
	});
}

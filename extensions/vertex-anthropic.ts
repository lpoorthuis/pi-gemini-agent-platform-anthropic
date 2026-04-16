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
const DEFAULT_MODELS = [
	"claude-opus-4-7",
	"claude-opus-4-6",
	"claude-sonnet-4-6",
	"claude-haiku-4-5@20251001",
];

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

function streamVertexAnthropic(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
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
			const location = process.env.GOOGLE_CLOUD_LOCATION || process.env.CLOUD_ML_REGION || DEFAULT_LOCATION;
			if (!project) {
				throw new Error("Set GOOGLE_CLOUD_PROJECT (or ANTHROPIC_VERTEX_PROJECT_ID) for Vertex Anthropic.");
			}

			const token = resolveAccessToken();
			const maxTokens = options?.maxTokens || Math.floor(model.maxTokens / 3);
			const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${project}/locations/${location}/publishers/anthropic/models/${model.id}:streamRawPredict`;

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

			const response = await fetch(url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					Accept: "text/event-stream",
				},
				body: JSON.stringify(body),
				signal: options?.signal,
			});

			if (!response.ok || !response.body) {
				const txt = await response.text();
				throw new Error(`Vertex Anthropic request failed: ${response.status} ${txt}`);
			}

			stream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
			const blocks = output.content as Block[];

			const reader = response.body.getReader();
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
	const raw = process.env.VERTEX_ANTHROPIC_MODELS?.trim();
	if (!raw) return DEFAULT_MODELS;
	return raw
		.split(",")
		.map((m) => m.trim())
		.filter(Boolean);
}

export default function (pi: ExtensionAPI) {
	const modelIds = parseModelListFromEnv();

	pi.registerProvider("vertex-anthropic", {
		// Dummy apiKey keeps provider selectable; actual auth comes from ADC via gcloud token retrieval.
		apiKey: "vertex-adc",
		api: "vertex-anthropic-api",
		baseUrl: "https://aiplatform.googleapis.com",
		models: modelIds.map((id) => ({
			id,
			name: `Vertex Anthropic: ${id}`,
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 64000,
		})),
		streamSimple: streamVertexAnthropic,
	});
}

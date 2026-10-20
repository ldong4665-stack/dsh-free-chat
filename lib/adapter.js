/**
 * free-chat 的 DSH 模型供应商适配器（LlmAdapter）。
 *
 * 把两个无账号 OpenAI 兼容通道注册成 DSH 原生供应商，让用户能在模型选择器里
 * 直接选中并对话（而不只是通过 free_chat 工具调用）：
 *
 *   free-g4f       → http://localhost:8080/v1   （gpt4free 聚合公开 Provider）
 *   free-chat2api  → http://localhost:8081/v1   （免登录档，模型名不含 gpt-4 落 3.5）
 *
 * 【致敬 · 上游与参考实现】
 * g4f 通道的上游是 GPT4Free / g4f（https://github.com/xtekky/gpt4free，
 * 作者 @xtekky，维护 @hlohaus，GPLv3）；chat2api 通道复刻自
 * lanqian528/chat2api（https://github.com/lanqian528/chat2api）的免登录
 * 协议语义。本适配器的 LlmAdapter 结构（六个必需方法、StreamChunk 组装、
 * block-end 闭合语义）参考了 DSH 生态 dsh-gateway-ui 插件的实现。
 * 本文件为再加工，向以上作者致谢。
 *
 * ── 为什么是「鸭子类型」而不是 extends ──
 * DSH 的注册表只按名字调用这些方法，不做 `instanceof` 校验；但方法**必须齐全**，
 * 缺一个就在真实调用时抛 `adapter.XXX is not a function`。必需：providerInfo /
 * providerRetryPolicy / listModels / resolveModel / prepareCall / stream。
 *
 * ── StreamChunk 协议（DSH 侧）──
 * 一次回复 = `block-start(index, blockType)` → 若干 `text-delta(index, text)` →
 * `block-end(index, block)` → `finish(reason)`。
 * ⚠️ `block-end` 必须带**完整块内容**（不是空串）：DSH 的 BlockAssembler 对
 * block-end 是「首次闭合者胜」，给空串会把整段正文静默丢弃。
 *
 * @module dsh-free-chat/adapter
 */

import { parseToolCalls } from './parse_tool_calls.js';

/**
 * 上游 finish_reason → DSH 的 FinishReason。
 *
 * ⚠️ DSH 要求的 `finish.reason` 是**对象**（`{kind: ...}`），不是字符串。
 * 发字符串 `'tool_calls'` 不会报错，但引擎按 `kind` 取值时取到 `undefined`，
 * 于是回落到「正常结束」⇒ 模型只输出文本、工具永不执行（本插件踩过这个坑，
 * 表现为「它还是只说不做」）。合法 kind：`stop` / `max-tokens` / `tool-calls` / `error`。
 *
 * @param {string|undefined} reason 上游的 finish_reason
 * @returns {{kind: string}} DSH 的 FinishReason
 */
function toFinishReason(reason) {
	if (reason === 'tool_calls' || reason === 'tool-calls') return { kind: 'tool-calls' };
	if (reason === 'length') return { kind: 'max-tokens' };
	return { kind: 'stop' };
}

/**
 * provider id → 上游 baseUrl。id 里带前缀，避免与既有供应商重名。
 *
 * 可用环境变量覆盖（与 free_chat 工具读同一组变量，保持两边一致）：
 *   FREE_G4F_URL      默认 http://localhost:8080/v1
 *   FREE_CHAT2API_URL 默认 http://localhost:8081/v1
 */
export const PROVIDERS = {
	'free-g4f': process.env.FREE_G4F_URL ?? 'http://localhost:8080/v1',
	'free-chat2api': process.env.FREE_CHAT2API_URL ?? 'http://localhost:8081/v1',
};

/** 供应商在模型选择器里显示的名字。 */
const PROVIDER_NAMES = {
	'free-g4f': 'Free (g4f 公开聚合)',
	'free-chat2api': 'Free (chat2api 免登录)',
};

/**
 * 每个供应商声明的模型清单。
 *
 * ⚠️ 这是**白名单**：上游 `/v1/models` 会列出几十个名字，全列出来会让选择器
 * 变成一长串。只暴露真实可用的少数几个。
 */
const MODEL_IDS = {
	'free-g4f': ['gpt-3.5-turbo', 'gpt-4o-mini', 'gpt-4o'],
	'free-chat2api': ['gpt-3.5-turbo', 'gpt-4o', 'gpt-4-turbo'],
};

/** 上游不一定会把这些带上，给个保守的上下文窗口。 */
const DEFAULT_CONTEXT_WINDOW = 16_384;
const DEFAULT_MAX_TOKENS = 4_096;

/** 单次请求超时。与 free_chat 工具保持一致：60 秒。 */
const TIMEOUT_MS = 60_000;

/**
 * chat2api 的免登录语义：模型名不含 `gpt-4` 时落到免登录 GPT-3.5 档。
 * ⚠️ 这是本供应商的对外契约，不能改。g4f 通道则原样透传（空则交给上游决定）。
 */
function resolveUpstreamModel(provider, model) {
	const id = typeof model === 'string' ? model : '';
	if (provider !== 'free-chat2api') return id;
	if (id === '' || !id.includes('gpt-4')) return 'gpt-3.5-turbo';
	return id;
}

/**
 * 把 DSH 的 ContentBlock 消息翻译成 OpenAI 形态。
 *
 * DSH 的 text / image 块与 OpenAI 的 content 数组基本同构；tool 调用走
 * assistant 的 `tool-calls` 块 + 独立 tool 角色消息。这里只处理文本与图片，
 * 工具调用不是本供应商的能力范围（公开 Provider 不稳定支持 function calling）。
 */
function toOpenAiMessages(messages) {
	const out = [];
	for (const msg of Array.isArray(messages) ? messages : []) {
		const role = msg?.role === 'assistant' ? 'assistant' : msg?.role === 'system' ? 'system' : 'user';
		const content = msg?.content;

		if (typeof content === 'string') {
			if (content.length > 0) out.push({ role, content });
			continue;
		}
		if (!Array.isArray(content)) continue;

		const parts = [];
		for (const block of content) {
			if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
				parts.push({ type: 'text', text: block.text });
			} else if (block?.type === 'image' && typeof block.data === 'string') {
				parts.push({
					type: 'image_url',
					image_url: { url: `data:${block.mimeType ?? 'image/png'};base64,${block.data}` },
				});
			}
		}
		if (parts.length === 0) continue;
		// 纯文本仍发字符串，最大化对公开 Provider 的兼容性。
		const textOnly = parts.every((p) => p.type === 'text');
		out.push({ role, content: textOnly ? parts.map((p) => p.text).join('\n') : parts });
	}
	return out;
}

/** 模型元数据。 */
function modelInfo(provider, id, name) {
	return { provider, id, name: name ?? id, inputModalities: ['text'] };
}

/**
 * 解析上游响应并产出 DSH 的 StreamChunk。
 *
 * ⚠️ 上游有**两种**可能的响应形态，必须都兼容：
 *   1. SSE 流（`data: {...}` 逐条），delta.content —— 标准流式
 *   2. 一次性 JSON（普通 chat.completion），message.content —— 本机服务
 *      目前**忽略 `stream:true`**，直接返回整包 JSON。只按 SSE 解析会得到
 *      「一个 chunk 都没有、正文为空」，实测踩过。
 *
 * 用生成器是因为「边收边吐」——公开 Provider 首字延迟常常好几秒，
 * 攒完再发会让 UI 一直转圈。
 */
async function* parseStream(response) {
	const contentType = String(response.headers?.get?.('content-type') ?? '');

	// 上游返回整包 JSON（最常见）：一次性读出，切成单块吐出。
	if (!contentType.includes('text/event-stream')) {
		const raw = await response.text();
		let data;
		try {
			data = JSON.parse(raw);
		} catch {
			throw new Error(`[free-chat] 上游返回非 JSON：${raw.slice(0, 200)}`);
		}

		const choice = Array.isArray(data?.choices) ? data.choices[0] : undefined;
		const text =
			typeof choice?.message?.content === 'string'
				? choice.message.content
				: typeof choice?.delta?.content === 'string'
					? choice.delta.content
					: typeof choice?.text === 'string'
						? choice.text
						: '';

		// 首选：上游已返回原生 tool_calls（如 G4F_TOOL_EMULATION 生效时），直通。
		const rawCalls = choice?.message?.tool_calls ?? choice?.delta?.tool_calls;
		if (Array.isArray(rawCalls) && rawCalls.length > 0) {
			yield* emitToolCalls(rawCalls);
			yield { type: 'finish', reason: toFinishReason('tool_calls') };
			return;
		}

		// 兜底：把文本形态的调用意图仿真成 tool_calls。
		const emulated = parseToolCalls(text);
		if (emulated !== null) {
			yield* emitToolCalls(emulated.toolCalls);
			yield { type: 'finish', reason: toFinishReason(emulated.finishReason) };
			return;
		}

		if (text.length > 0) {
			yield { type: 'block-start', index: 0, blockType: 'text' };
			yield { type: 'text-delta', index: 0, text };
			// ⚠️ block-end 必须带完整内容（见模块头注释）。
			yield { type: 'block-end', index: 0, block: { type: 'text', text } };
		}
		yield { type: 'finish', reason: toFinishReason(choice?.finish_reason) };
		return;
	}

	yield* parseSseStream(response);
}

/**
 * 把 OpenAI tool_calls 数组翻译成 DSH 的 StreamChunk 序列。
 *
 * chunk 形态与 dsh-gateway-ui 的 adapter 对齐：每个调用一个 block，
 * blockType 'tool-call'，block-end 时给出完整 {id, name, arguments}。
 *
 * @param {object[]} calls OpenAI tool_calls 元素
 * @param {number} [baseIndex=0] 块索引起点（同一回合已有文本块时往后排）
 */
function* emitToolCalls(calls, baseIndex = 0) {
	for (let i = 0; i < calls.length; i += 1) {
		const call = calls[i];
		const fn = call?.function ?? {};
		const args = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments ?? {});
		const index = baseIndex + i;
		const id = call?.id ?? `call_${Math.random().toString(36).slice(2, 10)}`;
		const name = fn.name ?? '';
		yield { type: 'block-start', index, blockType: 'tool-call' };
		yield { type: 'tool-call-delta', index, id, name, argumentsDelta: args };
		yield { type: 'block-end', index, block: { type: 'tool-call', id, name, arguments: args } };
	}
}

/**
 * 解析标准 SSE 流。
 */
async function* parseSseStream(response) {
	const reader = response.body?.getReader();
	if (reader === undefined) throw new Error('upstream returned no body stream');

	const decoder = new TextDecoder();
	let buffer = '';
	let textIndex = -1;
	let textBuffer = '';
	let finished = false;
	// 下一个可用的块索引：文本块占用 0 之后，工具块要往后排，
	// 否则两个块同索引会互相覆盖（引擎按 index 重组块）。
	let nextIndex = 0;

	const closeText = () => {
		if (textIndex === -1) return undefined;
		// ⚠️ block-end 必须带完整内容（见模块头注释）。
		const chunk = { type: 'block-end', index: textIndex, block: { type: 'text', text: textBuffer } };
		textIndex = -1;
		return chunk;
	};

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			// SSE 以空行分隔事件；按行处理更稳（上游有时夹杂注释行）。
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				if (!line.startsWith('data:')) continue;
				const payload = line.slice(5).trim();
				if (payload === '' || payload === '[DONE]') continue;

				let parsed;
				try {
					parsed = JSON.parse(payload);
				} catch {
					continue; // 半帧或非 JSON，跳过
				}

				const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : undefined;
				if (choice === undefined) continue;

				const delta = choice.delta;
				const piece = typeof delta?.content === 'string' ? delta.content : '';
				if (piece.length > 0) {
					if (textIndex === -1) {
						textIndex = nextIndex;
						nextIndex += 1;
						textBuffer = '';
						yield { type: 'block-start', index: textIndex, blockType: 'text' };
					}
					textBuffer += piece;
					yield { type: 'text-delta', index: textIndex, text: piece };
				}

				if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
					// 工具调用仿真：流式上游几乎不会发原生 tool_calls，模型把调用意图
					// 写进了正文。在 finish 前检查正文，命中就补发 tool-call 块。
					//
					// ⚠️ 此前已经流出的正文不能就地删除（chunk 已发给引擎），必须
					// 正常闭合——每个 block-start 都要有对应的 block-end，否则引擎
					// 会把该块当成未完成而丢弃。
					const emulated = parseToolCalls(textBuffer);
					if (emulated !== null) {
						const closing = closeText();
						if (closing !== undefined) yield closing;
						yield* emitToolCalls(emulated.toolCalls, nextIndex);
						finished = true;
						yield { type: 'finish', reason: toFinishReason(emulated.finishReason) };
						continue;
					}

					const closing = closeText();
					if (closing !== undefined) yield closing;
					finished = true;
					yield { type: 'finish', reason: toFinishReason(choice.finish_reason) };
				}
			}
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// 已释放
		}
	}

	// 上游没发 finish_reason 就断流：补一个 finish，否则 UI 会一直转圈。
	if (!finished) {
		const closing = closeText();
		if (closing !== undefined) yield closing;
		yield { type: 'finish', reason: toFinishReason('stop') };
	}
}

/**
 * DSH 的 LlmAdapter 实现（鸭子类型）。
 */
export class FreeChatAdapter {
	/**
	 * 描述一个 provider 路由。`id` 必须等于传入的 provider。
	 * @param {string} provider
	 */
	providerInfo(provider) {
		return { id: provider, name: PROVIDER_NAMES[provider] ?? provider };
	}

	/**
	 * 返回 `undefined` 用 DSH 的默认重试策略。
	 * ⚠️ 必须显式实现：`prepareRoutes` 无条件调用它，缺了直接抛 TypeError。
	 */
	providerRetryPolicy() {
		return undefined;
	}

	/** 本适配器不做独立图片计价。 */
	imageRequestPricing() {
		return undefined;
	}

	/**
	 * 列出可选模型。
	 * ⚠️ 模型选择器要用它做条目，返回空数组就等于「选择器里看不到这个供应商」。
	 * @param {string} provider
	 */
	listModels(provider) {
		const ids = MODEL_IDS[provider] ?? [];
		return Promise.resolve(ids.map((id) => modelInfo(provider, id)));
	}

	/**
	 * 解析一个精确模型的元数据。
	 * @param {string} provider
	 * @param {string} model
	 */
	resolveModel(provider, model) {
		return Promise.resolve({
			...modelInfo(provider, model),
			context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
			defaultMaxTokens: DEFAULT_MAX_TOKENS,
		});
	}

	/**
	 * 绑定模型元数据与本次调用的 stream 入口。
	 * ⚠️ 必需方法：`stream()` 的主路径在 `prepared === undefined` 时无条件调用它。
	 */
	async prepareCall(provider, model, signal) {
		return {
			model: await this.resolveModel(provider, model, signal),
			stream: (options) => this.stream(options, provider),
		};
	}

	/**
	 * 发起一次流式对话，产出 DSH 的 StreamChunk。
	 *
	 * 失败一律抛异常（DSH 会归类并展示），但**在吐出第一个 chunk 之前**失败才
	 * 有意义——已经流出一半正文再抛，客户端会看到半截内容。
	 *
	 * @param {object} options - DSH 的生成选项（messages / system / model / signal …）
	 * @param {string} providerOverride - prepareCall 传入的 provider（stream 主路径不带）
	 */
	async *stream(options, providerOverride) {
		const provider = providerOverride ?? options?.provider ?? 'free-g4f';
		const baseUrl = PROVIDERS[provider];
		if (baseUrl === undefined) throw new Error(`[free-chat] 未知供应商：${provider}`);

		const upstreamModel = resolveUpstreamModel(provider, String(options?.model ?? ''));

		const messages = toOpenAiMessages(options?.messages);
		if (typeof options?.system === 'string' && options.system.length > 0) {
			messages.unshift({ role: 'system', content: options.system });
		}
		if (messages.length === 0) throw new Error('[free-chat] 没有可发送的消息');

		const body = { model: upstreamModel, messages, stream: true };
		if (typeof options?.temperature === 'number') body.temperature = options.temperature;
		if (typeof options?.maxTokens === 'number') body.max_tokens = options.maxTokens;
		if (Array.isArray(options?.stop) && options.stop.length > 0) body.stop = options.stop;

		// 工具声明透传：DSH 把本次会话可用工具（bash/read/grep…）放在 options.tools。
		// 网页反代 provider 对 tools 的支持不稳定——模型往往收到了声明、却只输出
		// 文本形式的调用意图，因此在响应侧再做仿真解析（见 parseStream）。
		if (Array.isArray(options?.tools) && options.tools.length > 0) {
			body.tools = options.tools;

			// 网页反代模型普遍会「拒绝执行」：它以纯文本回复「我无法实际执行命令」，
			// 一个 tool_calls 都不发（实测 Yqcloud/gpt-4o 就是这样）。这不是解析问题，
			// 是模型行为问题，只能在提示侧强引导——把「必须用工具」写成硬约束，
			// 并把工具名与调用格式直接摆出来（模型照着格式输出，兜底解析才接得住）。
			const toolNames = options.tools
				.map((t) => t?.function?.name)
				.filter((n) => typeof n === 'string' && n.length > 0);
			if (toolNames.length > 0) {
				messages.unshift({
					role: 'system',
					content: [
						'You have access to tools and you MUST use them.',
						'When the task requires running a command, reading a file, or querying information, do NOT reply with prose and do NOT say you cannot do it — emit a tool call.',
						`Available tools: ${toolNames.join(', ')}.`,
						'Emit the call as a bare JSON object with exactly this shape, and nothing else:',
						'{"name": "<tool name>", "arguments": {"<param>": "<value>"}}',
						'Never refuse, never apologise, never explain that you are unable to execute. Just emit the JSON.',
					].join('\n'),
				});
			}
		}

		// 超时 + 遵守调用方取消（用户在 UI 点停止）。
		//
		// ⚠️ 定时器**只覆盖「等到响应头」这一段**，不能罩住整个流：
		// 流式响应的正文是一块块来的，一次长回复很容易超过 60 秒；若用
		// 总超时罩住，长输出会在中途被 abort，用户看到的是「打到一半断了」。
		// 所以拿到 response 后立刻 clearTimeout，正文阶段只受调用方取消约束。
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
		const onAbort = () => controller.abort();
		if (options?.signal !== undefined) {
			if (options.signal.aborted === true) {
				clearTimeout(timer);
				throw new Error('[free-chat] 调用已取消');
			}
			options.signal.addEventListener?.('abort', onAbort, { once: true });
		}

		try {
			let response;
			try {
				response = await fetch(`${baseUrl}/chat/completions`, {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
					body: JSON.stringify(body),
					signal: controller.signal,
				});
				// 响应头到手即解除首字节超时，正文流不受 60 秒限制。
				clearTimeout(timer);
			} catch (error) {
				if (controller.signal.aborted) {
					throw new Error(`[free-chat] ${provider}：请求超时（${TIMEOUT_MS}ms）或已取消`);
				}
				throw new Error(`[free-chat] ${provider}：连接上游失败（${error?.message ?? error}）`);
			}

			if (!response.ok) {
				const detail = await response.text().catch(() => '');
				throw new Error(
					`[free-chat] ${provider} 上游 ${response.status}：${String(detail).slice(0, 200)}`
				);
			}

			yield* parseStream(response);
		} finally {
			clearTimeout(timer);
			options?.signal?.removeEventListener?.('abort', onAbort);
		}
	}
}

export default FreeChatAdapter;

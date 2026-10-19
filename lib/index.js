/**
 * dsh-free-chat —— 无账号免费 OpenAI 兼容聊天的统一入口。
 *
 * 两条通道（均无需任何账号凭证）：
 *
 * | service    | baseUrl                          | 说明 |
 * |------------|----------------------------------|------|
 * | g4f        | http://localhost:8080/v1         | gpt4free 聚合多个公开 Provider |
 * | chat2api   | http://localhost:8081/v1         | 免登录模式；模型名不含 gpt-4 时自动落到 gpt-3.5 档 |
 *
 * 【致敬 · 上游与参考实现】
 * g4f 通道的上游是 GPT4Free / g4f（https://github.com/xtekky/gpt4free，
 * 作者 @xtekky，维护 @hlohaus，GPLv3）；chat2api 通道复刻自
 * lanqian528/chat2api（https://github.com/lanqian528/chat2api）的免登录
 * 协议语义。本插件的「tmux 承载 + 后台自举」服务管理模式参考了 DSH 生态
 * 的 dsh-qqbot-manager 实现，LlmAdapter 注册参考了 dsh-gateway-ui。
 * 本插件自身代码为再加工，向以上作者致谢。
 *
 * 为什么手工构造工具定义而不是 `defineTool({...})`：本包部署在
 * `~/dsh-plugins/free-chat/`，那里没有 `node_modules`，Node 的 ESM 解析
 * 够不着引擎的 `@deepseek-ai/dsh-tools`。`defineTool` 做的只是「把 spec
 * 形式的 schema 编译成 raw JSON Schema + 一层参数校验」，手工写 raw
 * JSON Schema 完全等价，参数校验由 `ctx.tools.register` 内部的
 * `validateJsonSchemaValue` 兜底。与 `dsh-android-shell` 同一做法。
 *
 * 所有 HTTP 请求带 60 秒超时（AbortController），绝不挂住 DSH 会话。
 * 失败一律返回结构化错误对象（isError 语义由 render 体现），execute 内
 * 不抛未捕获异常——上游断了、超时了、返回非 JSON 了，都只是「这条通道
 * 现在不可用」，不是插件崩溃。
 *
 * @module dsh-free-chat
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FreeChatAdapter, PROVIDERS as ADAPTER_PROVIDERS } from './adapter.js';

/** 本插件包根目录（用于定位仓库内的 server/ 与 scripts/）。 */
const PKG_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 通道 baseUrl 表。默认端口与任务契约固定：g4f→8080、chat2api→8081。
 *
 * 可用环境变量覆盖，指向任意主机（例如服务跑在另一台机器、或端口被占用时）：
 *   FREE_G4F_URL      默认 http://localhost:8080/v1
 *   FREE_CHAT2API_URL 默认 http://localhost:8081/v1
 */
const BASE_URLS = {
	g4f: process.env.FREE_G4F_URL ?? 'http://localhost:8080/v1',
	chat2api: process.env.FREE_CHAT2API_URL ?? 'http://localhost:8081/v1',
};

/** HTTP 超时：60 秒。上游 provider 偶尔很慢，短了会误杀。 */
const TIMEOUT_MS = 60_000;

export const name = 'dsh-free-chat';

/**
 * `tools` 是唯一硬依赖：注册工具必须有它。注入声明缺失时插件不激活，
 * 而不是运行时才抛错。
 * @type {string[]}
 */
export const inject = ['tools'];

/** 工具名。不与引擎内置工具冲突。 */
const TOOL_NAME = 'free_chat';

const DESCRIPTION = `Call a free, account-less OpenAI-compatible chat service and get a reply.

Two independent channels, both requiring no API key and no account:
- service="g4f" (default): gpt4free aggregating multiple public providers. Availability depends on which providers are alive today.
- service="chat2api": login-free mode. If the model name does NOT contain "gpt-4", it automatically falls back to the login-free GPT-3.5 tier.

Pass service, prompt, and optionally model. Returns the upstream reply text (choices[0].message.content) plus a compact status block. On failure it returns a structured error (service, baseUrl, stage, message) instead of throwing — switch service or retry later as the error suggests.`;

/**
 * 生成模型缺失时，chat2api 免登录档的默认模型名。
 * 纯约定字符串，不含任何凭证。
 */
const DEFAULT_MODEL_CHAT2API = 'gpt-3.5-turbo';

/** 计算最终模型名：chat2api 通道下，模型名不含 gpt-4 时落到免登录 GPT-3.5 档。 */
function resolveModel(service, model) {
	if (service === 'chat2api') {
		if (typeof model !== 'string' || model === '') return DEFAULT_MODEL_CHAT2API;
		if (!model.includes('gpt-4')) return DEFAULT_MODEL_CHAT2API;
		return model;
	}
	// g4f：可留空由上游决定。
	return typeof model === 'string' && model !== '' ? model : undefined;
}

/**
 * 把上游 JSON 响应规范成「有效回复」结果对象。
 *
 * ⚠️ 返回值必须是 **lossless JSON**：DSH 的工具输出校验会拒绝含
 * `undefined` 的对象（`value is not lossless JSON`）。所以这里所有字段
 * 都落成确定的字符串/布尔值，绝不留 `undefined`。
 */
function replyResult(data, modelUsed, service, baseUrl) {
	const text =
		data?.choices?.[0]?.message?.content ??
		data?.choices?.[0]?.text ??
		'';
	return {
		ok: true,
		service,
		baseUrl,
		modelUsed: typeof modelUsed === 'string' ? modelUsed : '',
		content: typeof text === 'string' ? text : JSON.stringify(text ?? ''),
		provider: typeof data?.provider === 'string' ? data.provider : '',
	};
}

/**
 * 执行一次通道调用。
 *
 * 失败永远返回 `{ ok:false, ... }` 对象而非抛异常——这是本插件的核心
 * 契约：模型拿到的是可读的错误状态，不是崩溃。
 *
 * @param {string} service 通道名
 * @param {string} prompt 用户 prompt
 * @param {string|undefined} model 模型名
 * @param {Set<AbortController>} abortControllers 活跃请求集合（disposer 用）
 * @returns {Promise<object>} 结构化结果
 */
async function callChannel(service, prompt, model, abortControllers) {
	const baseUrl = BASE_URLS[service];
	const modelUsed = resolveModel(service, model);
	const body = {
		messages: [{ role: 'user', content: prompt }],
		...(modelUsed === undefined ? {} : { model: modelUsed }),
	};

	const controller = new AbortController();
	abortControllers.add(controller);
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(`${baseUrl}/chat/completions`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		const text = await res.text();
		if (!res.ok) {
			return failResult(service, baseUrl, 'http-status', {
				status: res.status,
				message: `upstream ${res.status}: ${truncate(text)}`,
				hint:
					service === 'g4f'
						? 'g4f availability depends on live providers today; switch service or retry later.'
						: 'chat2api login-free tier may be unavailable; switch service or retry later.',
			});
		}
		let data;
		try {
			data = JSON.parse(text);
		} catch {
			return failResult(service, baseUrl, 'parse-json', {
				status: res.status,
				message: `upstream returned non-JSON: ${truncate(text)}`,
			});
		}
		return replyResult(data, modelUsed, service, baseUrl);
	} catch (error) {
		if (error?.name === 'AbortError') {
			return failResult(service, baseUrl, 'timeout', {
				message: `request timed out after ${TIMEOUT_MS}ms`,
			});
		}
		return failResult(service, baseUrl, 'fetch', {
			message: String(error?.message ?? error),
		});
	} finally {
		clearTimeout(timer);
		abortControllers.delete(controller);
	}
}

function truncate(text, limit = 300) {
	const s = typeof text === 'string' ? text.trim() : String(text ?? '');
	return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

/**
 * 构造失败结果。字段集合与成功结果保持一致且**全部有确定值**
 * （DSH 输出校验要求 lossless JSON，`undefined` 会被判为不合法）。
 */
function failResult(service, baseUrl, stage, extra) {
	return {
		ok: false,
		service,
		baseUrl,
		modelUsed: '',
		content: '',
		stage,
		status: typeof extra?.status === 'number' ? extra.status : 0,
		message: typeof extra?.message === 'string' ? extra.message : '',
		hint: typeof extra?.hint === 'string' ? extra.hint : '',
		provider: '',
	};
}

/** 渲染模型可见文本。失败也渲染成可读块，而不是红屏。 */
function renderText(value) {
	if (value?.ok) {
		const meta = [`service=${value.service}`];
		if (value.modelUsed) meta.push(`model=${value.modelUsed}`);
		if (value.provider) meta.push(`provider=${value.provider}`);
		let out = typeof value.content === 'string' ? value.content : '';
		if (out.length === 0) out = '(empty reply from upstream)';
		return `${out}\n\n[${meta.join(' | ')}]`;
	}
	const where = value?.stage || 'unknown';
	return [
		`[free_chat error] service=${value?.service || '?'} stage=${where}`,
		`${value?.message || '(no message)'}`,
		value?.hint ? `hint: ${value.hint}` : '',
	]
		.filter(Boolean)
		.join('\n');
}

// ─────────────────────────── 服务自启动 ───────────────────────────

/**
 * 本地部署配置。
 *
 * 解析顺序（前者覆盖后者）：进程环境变量 → `scripts/local-env.sh` → 内置默认。
 *
 * `scripts/local-env.sh` 是**本机专用覆盖文件**，已被 .gitignore 忽略——
 * 用来记录「容器名 / venv 路径 / Termux 前缀」这类只对当前机器有意义的东西。
 * 开源用户 clone 后没有这个文件，走通用默认（同机直接跑 python3 + 仓库内
 * server/），不需要任何配置即可使用。
 *
 * 环境变量 / local-env.sh 可设项：
 *   FREE_CHAT_AUTOSTART     '0' 关闭引擎启动时的服务自举（默认开启）
 *   FREE_CHAT_CONTAINER     proot 容器名（如 napcat）；不设 = 不用容器
 *   FREE_CHAT_PYTHON        Python 解释器路径；不设 = 自动探测
 *   FREE_CHAT_SERVER_DIR    server 脚本目录；不设 = 仓库内 server/
 *   FREE_CHAT_TERMUX_PREFIX Termux 前缀；不设 = 非 Termux 环境
 *   FREE_CHAT_TMUX_TMPDIR   tmux socket 目录；不设 = 系统默认
 */
function loadLocalConfig() {
	const conf = {};
	const source = path.join(PKG_DIR, 'scripts', 'local-env.sh');
	try {
		const text = fs.readFileSync(source, 'utf8');
		for (const raw of text.split('\n')) {
			const line = raw.trim();
			if (line.startsWith('#') || line.length === 0) continue;
			const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
			if (m === null) continue;
			conf[m[1]] = m[2].replace(/^['"]|['"]$/g, '').trim();
		}
	} catch {
		// 无本地配置文件 = 走通用默认，正常路径。
	}
	const get = (key) => process.env[key] ?? conf[key];
	return {
		autostart: get('FREE_CHAT_AUTOSTART'),
		container: get('FREE_CHAT_CONTAINER'),
		python: get('FREE_CHAT_PYTHON'),
		serverDir: get('FREE_CHAT_SERVER_DIR'),
		termuxPrefix: get('FREE_CHAT_TERMUX_PREFIX'),
		tmuxTmpdir: get('FREE_CHAT_TMUX_TMPDIR'),
	};
}

const LOCAL = loadLocalConfig();

/** Termux 前缀（非 Termux 环境为 null，此时 PATH 不额外注入）。 */
const TERMUX_PREFIX = LOCAL.termuxPrefix?.trim() || null;

/**
 * tmux socket 的解析根。**在 Termux 上必须是共享 TMPDIR**：Termux 的 tmux 用
 * `$TMPDIR/tmux-<uid>/default` 作 socket 路径，而引擎进程的 TMPDIR 与之不同，
 * 沿用默认值会让 `tmux has-session` 连到另一个 socket（表现为 "no server"），
 * 于是一个会话都看不到、反复重复启动。非 Termux 环境用系统默认即可。
 */
const TMUX_TMPDIR = LOCAL.tmuxTmpdir?.trim() || null;

/** 两个服务对应的 tmux 会话名、端口与入口脚本文件名。 */
const SERVICES = [
	{ session: 'freechat-g4f', port: 8080, file: 'g4f_server.py' },
	{ session: 'freechat-c2a', port: 8081, file: 'chat2api_server.py' },
];

/** server 脚本目录：默认仓库内 server/。 */
const SERVER_DIR = LOCAL.serverDir?.trim() || path.join(PKG_DIR, 'server');

/** Python 解释器：显式指定优先，否则探测（仓库 venv → 系统 python3）。 */
function resolvePython() {
	if (LOCAL.python && LOCAL.python.trim() !== '') return LOCAL.python.trim();
	const venvPython = path.join(PKG_DIR, 'venv', 'bin', 'python');
	if (fs.existsSync(venvPython)) return venvPython;
	return 'python3';
}

/** 服务管理命令都是秒级，超时给 60 秒。 */
const RUN_TIMEOUT_MS = 60_000;

/** tmux 可执行文件：Termux 下用绝对路径，否则 PATH 里找。 */
function tmuxBin() {
	return TERMUX_PREFIX ? `${TERMUX_PREFIX}/bin/tmux` : 'tmux';
}

/** 拼装「跑某个 server」的命令行（按是否用容器分两种）。 */
function buildServerCommand(python, script) {
	if (LOCAL.container && LOCAL.container.trim() !== '') {
		return `proot-distro login ${LOCAL.container.trim()} -- ${python} ${script}`;
	}
	return `${python} ${script}`;
}

/**
 * 用固定 PATH / TMPDIR 跑一条命令。
 *
 * 不用 `ctx.shell`（那是 uid 2000 通道，读不到 app 私有目录）；普通
 * spawn 就够了，与 dsh-qqbot-manager 同一做法。
 */
function runCommand(command, timeoutMs = RUN_TIMEOUT_MS) {
	return new Promise((resolve) => {
		const env = { ...process.env };
		if (TMUX_TMPDIR !== null) env.TMPDIR = TMUX_TMPDIR;
		if (TERMUX_PREFIX !== null) {
			env.PATH = `${TERMUX_PREFIX}/bin:/system/bin:/system/xbin`;
		}
		env.HOME = process.env.HOME ?? '/data/user/0/com.dsh.android/files/home';

		let child;
		try {
			child = spawn('bash', ['-c', command], {
				env,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (error) {
			resolve({ stdout: '', stderr: String(error), exitCode: null });
			return;
		}

		let stdout = '';
		let stderr = '';
		child.stdout?.on('data', (d) => { stdout += d; });
		child.stderr?.on('data', (d) => { stderr += d; });

		const timer = setTimeout(() => {
			try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
			resolve({ stdout, stderr: `${stderr}\n[timeout ${timeoutMs}ms]`, exitCode: null });
		}, timeoutMs);

		child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code }); });
		child.on('error', (err) => { clearTimeout(timer); resolve({ stdout, stderr: String(err), exitCode: null }); });
	});
}

/**
 * 直连端口探测。比 spawn curl 快，且不受环境差异影响。
 * 容器与宿主共享网络命名空间，所以宿主 localhost 就是容器 localhost。
 */
function probePort(port) {
	return new Promise((resolve) => {
		const socket = net.createConnection({ port, host: '127.0.0.1', timeout: 1500 });
		socket.on('connect', () => { socket.destroy(); resolve(true); });
		socket.on('timeout', () => { socket.destroy(); resolve(false); });
		socket.on('error', () => resolve(false));
	});
}

/** tmux 会话是否存在。`has-session` 比解析 `ls` 输出更稳。 */
async function hasTmuxSession(name) {
	const { exitCode } = await runCommand(
		`exec ${tmuxBin()} has-session -t ${name} 2>/dev/null`,
		10_000,
	);
	return exitCode === 0;
}

/** 服务日志目录：优先仓库内，写不进（只读挂载）时退到系统临时目录。 */
function logDir() {
	const inPkg = path.join(PKG_DIR, 'logs');
	try {
		fs.mkdirSync(inPkg, { recursive: true });
		return inPkg;
	} catch {
		return '/tmp';
	}
}

/**
 * 确保某个服务在跑。幂等：端口已在听就什么都不做。
 * @returns {Promise<string>} 结果描述，用于日志
 */
async function ensureService(svc) {
	if (await probePort(svc.port)) return `${svc.session}: up (:${svc.port})`;

	if (await hasTmuxSession(svc.session)) {
		// 会话在但端口没起——多半是刚启动还在初始化，交给调用方等待。
		return `${svc.session}: session exists, port not ready yet`;
	}

	const python = resolvePython();
	const script = path.join(SERVER_DIR, svc.file);
	const cmd = [
		`exec ${tmuxBin()} new-session -d -s ${svc.session}`,
		`"${buildServerCommand(python, script)}`,
		`> ${path.join(logDir(), `${svc.session}.log`)} 2>&1"`,
	].join(' ');

	const { exitCode, stderr } = await runCommand(cmd);
	if (exitCode !== 0) return `${svc.session}: start failed (${stderr.trim().slice(0, 120)})`;
	return `${svc.session}: started`;
}

/**
 * 后台自举：引擎每次启动时确保两个服务在线。
 *
 * ⚠️ 必须**不阻塞** apply()：服务冷启动要十几秒，卡住会让引擎启动超时。
 * 也不能抛异常——自举失败只应记日志，不能拖垮引擎。
 *
 * 设置 `FREE_CHAT_AUTOSTART=0`（环境变量或 scripts/local-env.sh）可关闭——
 * 适合已经有 systemd / launchd 等外部托管的环境。
 */
function bootstrapServices(ctx) {
	const log = (msg) => ctx?.logger?.info?.(`[dsh-free-chat] bootstrap: ${msg}`);

	if (LOCAL.autostart?.trim() === '0' || LOCAL.autostart?.trim() === 'false') {
		log('disabled by FREE_CHAT_AUTOSTART=0');
		return;
	}

	// 已经有服务在听就不折腾（常见情形：用户手动起过）。
	(async () => {
		try {
			const results = [];
			for (const svc of SERVICES) {
				results.push(await ensureService(svc));
			}
			log(results.join(' | '));

			// 首次启动的进程需要几秒初始化，轮询到就绪（最多 ~20 秒）。
			for (const svc of SERVICES) {
				let ready = false;
				for (let i = 0; i < 20; i += 1) {
					if (await probePort(svc.port)) { ready = true; break; }
					await new Promise((r) => setTimeout(r, 1000));
				}
				log(`${svc.session} (:${svc.port}) => ${ready ? 'ready' : 'NOT READY'}`);
			}
		} catch (error) {
			log(`failed: ${error?.message ?? error}`);
		}
	})();
}

/**
 * 把两个通道注册成 DSH 原生模型供应商。
 *
 * 用 `ctx.inject(['llm'], …)` 等 `llm` 服务就绪后再注册，而不是在 apply 里
 * 直接调用——`llm` 由 DSH 自己提供，注入时机不由本插件决定。
 *
 * ⚠️ `registerAdapter` 对已存在的 provider 抛 `DUPLICATE_ADAPTER`（全有或全无），
 * 所以整段包 try/catch：注册失败只应记日志，不能把引擎启动拖下水。
 * @param {object} ctx - Cordis 上下文
 */
function registerProviders(ctx) {
	ctx.inject(['llm'], (c) => {
		const providers = Object.keys(ADAPTER_PROVIDERS);
		try {
			const adapter = new FreeChatAdapter();
			c.effect(
				() => c.llm.registerAdapter(providers, adapter),
				'dsh-free-chat: llm adapter（free-g4f / free-chat2api）'
			);
			c?.logger?.info?.(
				`[dsh-free-chat] 已注册模型供应商：${providers.join(', ')}`
			);
		} catch (error) {
			c?.logger?.warn?.(
				`[dsh-free-chat] 注册模型供应商失败（不影响 free_chat 工具）: ${error?.message ?? error}`
			);
		}
	});
}

/**
 * 注册 `free_chat` 工具。前置不满足（无 ctx.tools）时由 inject 语义拦截，
 * 这里不重复检查；register 本身包 try/catch——注册抛异常会让 cordis 判定
 * 插件 failed，进而引擎启动失败，真机实测过同类事故。
 * @param {object} ctx - Cordis 上下文（需 `tools` 服务）。
 */export function apply(ctx) {
	/** 活跃请求的AbortController 集合，供 disposer 在插件卸载时统一中止。 */
	const abortControllers = new Set();

	ctx?.logger?.info?.(
		`[dsh-free-chat] 注册工具 ${TOOL_NAME}: g4f→${BASE_URLS.g4f}, chat2api→${BASE_URLS.chat2api}`
	);

	try {
		ctx.tools.register({
			name: TOOL_NAME,
			description: DESCRIPTION,
			parameters: {
				type: 'object',
				additionalProperties: false,
				properties: {
					service: {
						type: 'string',
						enum: ['g4f', 'chat2api'],
						description: 'Which channel to call: "g4f" (aggregated public providers) or "chat2api" (login-free tier).',
					},
					prompt: {
						type: 'string',
						description: 'The user prompt to send.',
					},
					model: {
						type: 'string',
						description: 'Optional model name. For chat2api, a name not containing "gpt-4" automatically falls back to the login-free GPT-3.5 tier; for g4f, empty means the upstream decides.',
					},
				},
				required: ['prompt'],
			},
			output: {
				schema: {
					type: 'object',
					additionalProperties: true,
					properties: {
						ok: { type: 'boolean' },
						service: { type: 'string' },
						baseUrl: { type: 'string' },
						modelUsed: { type: 'string' },
						content: { type: 'string' },
						stage: { type: 'string' },
						status: { type: 'number' },
						message: { type: 'string' },
						hint: { type: 'string' },
						provider: { type: 'string' },
					},
				},
				render: (_args, value) => [{ type: 'text', text: renderText(value) }],
			},
			async execute(args) {
				const service = BASE_URLS[args.service] ? args.service : 'g4f';
				const prompt = typeof args.prompt === 'string' ? args.prompt : '';
				try {
					return await callChannel(service, prompt, args.model, abortControllers);
				} catch (error) {
					// 兜底：理论上 callChannel 已全捕获，这里是双保险。
					return failResult(service, BASE_URLS[service], 'execute', {
						message: String(error?.message ?? error),
					});
				}
			},
		});
	} catch (error) {
		ctx?.logger?.warn?.(
			`[dsh-free-chat] 注册 ${TOOL_NAME} 工具失败，本插件不激活（引擎继续启动）: ${error?.message ?? error}`
		);
		return;
	}

	// 本插件没有自定义 Agent 等重资源，唯一的「手动清理资源」就是活跃的
	// HTTP 请求：插件卸载时统一中止，避免句柄泄漏。
	ctx.effect(() => {
		return () => {
			for (const controller of abortControllers) {
				try {
					controller.abort();
				} catch {
					// 忽略：已完成的请求 abort 是 no-op。
				}
			}
			abortControllers.clear();
		};
	}, 'dsh-free-chat: abort in-flight HTTP requests');

	// 每次引擎启动时后台确保两个服务在线（不阻塞、不抛异常）。
	// 服务的进程生命周期由 tmux 持有，所以插件卸载时**不**杀服务——
	// 那属于用户显式操作（tmux kill-session）。
	bootstrapServices(ctx);

	// 把两个通道注册成 DSH 原生模型供应商，让用户能在模型选择器里直接选中对话。
	registerProviders(ctx);
}

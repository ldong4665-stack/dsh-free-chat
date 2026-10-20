/**
 * 工具调用仿真翻译：把网页反代模型输出的纯文本还原成 OpenAI tool_calls。
 *
 * 背景：g4f / chat2api 的网页反代 provider 普遍不支持 OpenAI tools 协议——
 * 模型收到了 tools 声明，也知道「该调工具」，但 reply 里只输出文本形态的
 * 调用意图（JSON / _mex/  /  标签 / 字符串化调用），DSH 不认，于是
 * 工具永不触达。本模块做最后一道兜底：文本 → 标准 tool_calls。
 *
 * 覆盖三种文本形态（优先级从高到低）：
 *   1. ` {...}  ...  {...} ` 标签包裹的 JSON
 *   3. 字符串化调用：`shell(command="ls", description="x")`
 *
 * 约束（不可违背）：
 *   - 解析失败一律返回 null，调用方降级为普通文本，**不抛异常、不吞原文**
 *   - 只做「文本 → 结构」转换，不执行任何工具
 *   - 提取 JSON 用平衡大括号扫描，避免嵌套 / 字符串内大括号截断
 *
 * @module dsh-free-chat/parse_tool_calls
 */

// 标签字面量在本环境的文件写入中会被吞掉，只能拼接构建，切勿直接写字面量。
const _T = 'tool' + '_' + 'call';
const TAG_OPEN = '<' + _T + '>';
const TAG_CLOSE = '</' + _T + '>';

/**
 * 从纯文本平衡地提取一个 JSON 对象 / 数组。
 *
 * 扫描规则：跟踪引号与反斜杠（字符串内的 `{` 不计数）、记录括号深度，
 * 深度归零即返回完整片断。这样嵌套对象、带 `{` 的字符串值都不会被截断。
 *
 * @param {string} text 源文本
 * @param {number} start 起始扫描位置（必须指向 `{` 或 `[`）
 * @returns {{text: string, end: number}|null} 提取到的片断与结束位置
 */
function extractBalanced(text, start) {
	const open = text[start];
	const close = open === '{' ? '}' : ']';
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = start; i < text.length; i += 1) {
		const ch = text[i];
		if (inString) {
			if (escaped) { escaped = false; continue; }
			if (ch === '\\') { escaped = true; continue; }
			if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') { inString = true; continue; }
		if (ch === open) depth += 1;
		else if (ch === close) {
			depth -= 1;
			if (depth === 0) return { text: text.slice(start, i + 1), end: i + 1 };
		}
	}
	return null;
}

/** 安全 JSON 解析。 */
function tryParseJson(raw) {
	if (typeof raw !== 'string') return null;
	try {
		return JSON.parse(raw);
	} catch {
		// 容忍尾随逗号 / 单引号等小毛病：先剥一遍再试
		try {
			return JSON.parse(raw.replace(/,(\s*[}\]])/g, '$1'));
		} catch {
			return null;
		}
	}
}

/**
 * 把一个候选 JSON 文本规范化成 OpenAI tool_calls 元素。
 *
 * 接受三种模型常见写法：
 *   {"name": "shell", "arguments": {...}}            （规范）
 *   {"name": "shell", "arguments": "{...}"}          （arguments 已是字符串）
 *   {"tool": "shell", "parameters": {...}}           （旧式 / 各家变体）
 *   {"function": "shell", "input": {...}}
 *
 * @param {object} obj
 * @returns {object|null} OpenAI tool_calls 元素或 null
 */
function normalizeCall(obj) {
	if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;

	let name = obj.name ?? obj.tool ?? obj.function ?? obj.tool_name;

	// 只给了参数、没给工具名的形态：`{"command": "am start ..."}`
	// （实测 gpt-4o 经常省掉 name，默认就是 shell）。有 shell 参数签名时补名。
	if (typeof name !== 'string' || name.length === 0) {
		if (typeof obj.command === 'string' && obj.command.length > 0) name = 'shell';
		else return null;
	}

	// 模型常把 OpenAI 的包装前缀也写进名字：`functions.shell`、`function.bash`、
	// `tools.shell`（实测同一任务多次调用时反复出现）。DSH 按裸工具名查表，
	// 带前缀一律查不到 ⇒ 工具永不执行，界面表现为「说了要调，什么都没发生」。
	name = name.replace(/^(?:functions?|tools?)\./i, '').trim();
	if (name.length === 0) return null;

	let args = obj.arguments ?? obj.parameters ?? obj.input ?? obj.args;
	if (args === undefined || args === null) {
		// 平铺写法：`{"tool":"shell","command":"ls"}`——工具名与参数在同一层，
		// 参数没有被 arguments/parameters 包起来。把除名字键以外的字段都当参数。
		// 实测 gpt-4o-mini 在多次重试时会切到这种形态。
		const nameKeys = new Set(['name', 'tool', 'function', 'tool_name']);
		const flat = {};
		for (const [key, value] of Object.entries(obj)) {
			if (nameKeys.has(key)) continue;
			flat[key] = value;
		}
		args = flat;
	}
	if (typeof args === 'string') {
		const parsed = tryParseJson(args);
		args = parsed ?? { _: args };
	}
	if (typeof args !== 'object' || Array.isArray(args)) args = { _: String(args) };

	// ⚠️ 空参数调用比纯文本更糟：DSH 会真的去执行一个参数为空的动作，
	// 结果是什么都没发生（用户看到「调了但没反应」）。模型输出
	// `{"name":"shell","arguments":{}}` 时宁可降级为文本，让它把命令展示出来。
	if (Object.keys(args).length === 0) return null;

	return {
		id: `call_${Math.random().toString(36).slice(2, 10)}`,
		type: 'function',
		function: { name, arguments: JSON.stringify(args) },
	};
}

/** 从 ` name(arg="x", n=1)` 形态还原结构化参数。 */
function parseStringifiedCall(segment) {
	const m = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*\(([\s\S]*)\)\s*$/.exec(segment.trim());
	if (m === null) return null;

	const argsText = m[2].trim();
	const args = {};
	if (argsText.length > 0) {
		// 按逗号切分（忽略括号/引号内的逗号）
		const parts = [];
		let depth = 0;
		let inString = false;
		let escaped = false;
		let buf = '';
		for (const ch of argsText) {
			if (inString) {
				buf += ch;
				if (escaped) { escaped = false; continue; }
				if (ch === '\\') { escaped = true; continue; }
				if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') { inString = true; buf += ch; continue; }
			if (ch === '(' || ch === '[' || ch === '{') depth += 1;
			else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
			if (ch === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
			buf += ch;
		}
		if (buf.trim().length > 0) parts.push(buf);

		for (const part of parts) {
			const kv = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*([\s\S]*?)\s*$/.exec(part);
			if (kv === null) continue;
			let value = kv[2];
			if (value.startsWith('"') && value.endsWith('"')) {
				value = value.slice(1, -1).replace(/\\"/g, '"');
			} else {
				const j = tryParseJson(value);
				value = j ?? value;
			}
			args[kv[1]] = value;
		}
	}

	return {
		id: `call_${Math.random().toString(36).slice(2, 10)}`,
		type: 'function',
		function: {
			// 同样剥掉 `functions.` / `tools.` 包装前缀。
			name: m[1].replace(/^(?:functions?|tools?)\./i, ''),
			arguments: JSON.stringify(args),
		},
	};
}

/**
 * 从一段模型文本中提取工具调用。
 *
 * @param {string} content 模型输出的原始文本
 * @returns {{toolCalls: object[], finishReason: string}|null}
 *          提取不到返回 null（调用方降级为普通文本）
 */
export function parseToolCalls(content) {
	if (typeof content !== 'string' || content.trim().length === 0) return null;

	const found = [];

	// 1) <tool_call>…</tool_call> 标签段（每对标签之间可能有多个 JSON 调用）
	const segs = [];
	let searchFrom = 0;
	while (true) {
		const open = content.indexOf(TAG_OPEN, searchFrom);
		if (open === -1) break;
		const innerStart = open + TAG_OPEN.length;
		const close = content.indexOf(TAG_CLOSE, innerStart);
		segs.push(close === -1 ? content.slice(innerStart) : content.slice(innerStart, close));
		searchFrom = close === -1 ? content.length : close + TAG_CLOSE.length;
	}
	for (const seg of segs) {
		collectJsonObjects(seg, found);
	}
	if (found.length > 0) {
		return { toolCalls: found, finishReason: 'tool_calls' };
	}

	// 2) 裸 JSON 对象（模型直接输出 {…}）
	//    只在文本看起来「像」工具调用时认：含 name/tool/function 之一
	if (collectJsonObjects(content, found, { requireCallShape: true })) {
		return { toolCalls: found, finishReason: 'tool_calls' };
	}

	// 3) 字符串化调用：`shell(command="ls")`
	//    判据（防止 `f(x) { return x }` 这类代码误触发）：
	//    a) 文本里存在 `identifier(...)` 的平衡括号片段
	//    b) 最后一个闭合括号之后**不能有代码块特征**（`{` / `;` / `=>`）——
	//       函数体的花括号就是代码，真正的工具调用后面只有说明文字或空
	const leadTrim = content.trim();
	const names = [...leadTrim.matchAll(/(^|[^.\w])([A-Za-z_][A-Za-z0-9_.-]*)\s*\(/g)];
	let matched = null;
	for (const nm of names) {
		const nameStart = nm.index + nm[0].length - nm[2].length - 1;
		let depth = 0;
		let inString = false;
		let escaped = false;
		let end = -1;
		for (let i = nameStart + nm[2].length; i < leadTrim.length; i += 1) {
			const ch = leadTrim[i];
			if (inString) {
				if (escaped) { escaped = false; continue; }
				if (ch === '\\') { escaped = true; continue; }
				if (ch === '"') inString = false;
				continue;
			}
			if (ch === '"') { inString = true; continue; }
			if (ch === '(') depth += 1;
			else if (ch === ')') {
				depth -= 1;
				if (depth === 0) { end = i + 1; break; }
			}
		}
		if (end === -1) continue;
		const tail = leadTrim.slice(end);
		if (tail.includes('{') || tail.includes(';') || tail.includes('=>')) continue;
		matched = leadTrim.slice(nameStart, end);
		break;
	}
	if (matched !== null) {
		const call = parseStringifiedCall(matched);
		if (call !== null) {
			found.push(call);
			return { toolCalls: found, finishReason: 'tool_calls' };
		}
	}

	// 3.5) 「工具名 + 换行 + 命令」形态
	//
	// 模型有时这样表达：`shell\nmonkey -p com.tencent.mobileqq 1`
	// （第一行是工具名，后面整段是要执行的命令）。只在首行确实是已知的
	// 执行类工具名时才认，避免把普通多行文本误当命令。
	const NL_CALL_RE = /^(shell|bash|sh|zsh|exec|run)\s*\n+([\s\S]+)$/i;
	const nlCall = NL_CALL_RE.exec(content.trim());
	if (nlCall !== null) {
		const command = nlCall[2].trim();
		if (command.length > 0 && command.length < 500) {
			return {
				toolCalls: [{
					id: `call_${Math.random().toString(36).slice(2, 10)}`,
					type: 'function',
					function: { name: nlCall[1].toLowerCase(), arguments: JSON.stringify({ command }) },
				}],
				finishReason: 'tool_calls',
			};
		}
	}

	// 4) 围栏代码块里的命令
	//
	// 这里要处理模型最常见的「拒绝 + 给命令」形态：
	//   「抱歉，我无法直接执行。你可以运行：```bash
	//    am start -n com.tencent.mobileqq/... ```」
	//
	// 模型的措辞是拒绝，但它给的那条命令**正是用户想要的**。用户说「打开
	// QQ」，他要的结果是 QQ 被打开，不是被告知怎么自己开。所以这里仍然
	// 还原成调用——但判据必须卡死，否则会拿用户电脑上的教程命令去乱跑：
	//   · 命令必须针对**本机**（不含 adb / 不含电脑侧步骤）
	//   · 命令必须是可执行动作（am / monkey / pm / input / settings / ls …）
	//   · 教程里那种「先装 ADB、再连 USB」的前置条件文本一律不认
	const fence = /```(?:bash|sh|shell|zsh)?\s*\n([\s\S]*?)```/i.exec(content);
	if (fence !== null) {
		const rawCommand = fence[1].trim();
		const command = stripAdbWrapper(rawCommand);
		const looksLikeCommand = command.length > 0
			&& command.length < 500
			&& !command.includes('\n\n')
			&& /^[a-zA-Z_./]/.test(command);

		// 电脑侧/教程侧的命令：要用户在**电脑**上操作，不是我们能跑的。
		// ⚠️ 只按正文里的前置条件判断——命令本身可能已经被 stripAdbWrapper 洗干净。
		const isRemoteTutorial = /\bWindows\b|\bmacOS\b|\bPowerShell\b|\bCMD\b|开发工具/i.test(command)
			|| /USB\s*调试|安装\s*ADB|安装\s*Android\s*调试|adb\s+(?:devices|connect|pair)/i.test(content);

		if (looksLikeCommand && !isRemoteTutorial) {
			return {
				toolCalls: [{
					id: `call_${Math.random().toString(36).slice(2, 10)}`,
					type: 'function',
					function: { name: 'shell', arguments: JSON.stringify({ command }) },
				}],
				finishReason: 'tool_calls',
			};
		}
	}

	return null;
}

/**
 * 剥掉 `adb shell` 包装，取出真正能在本机执行的命令。
 *
 * 为什么需要这一步：模型几乎总是把命令写成 `adb shell am start ...`——
 * 它以为命令要经由电脑上的 ADB 下发。但这台设备**就是**那台 Android 设备，
 * 而且我们自己就有 shell 权限：去掉 `adb shell` 前缀后，剩下的
 * `am start ...` 正好是本机能直接跑的命令，结果完全一致。
 *
 * 只处理明确的包装形态，不做泛化改写（避免把真要在电脑上跑的东西搬进来）：
 *   adb shell am start -n ...   →  am start -n ...
 *   adb shell pm list packages  →  pm list packages
 *   adb -s <serial> shell ...   →  ...
 *   adb shell "..."             →  ...
 *
 * `adb devices` / `adb connect` / `adb push` 这类**只能**在电脑上执行的
 * 命令不剥（剥了也没意义），原样留着让上层判定为远程教程。
 */
function stripAdbWrapper(command) {
	let cmd = command.trim();

	// adb [-s serial | -d | -e] shell <inner>
	const wrapped = /^adb\s+(?:-s\s+\S+\s+|-d\s+|-e\s+)?shell\s+([\s\S]+)$/i.exec(cmd);
	if (wrapped !== null) {
		cmd = wrapped[1].trim();
		// `adb shell "am start ..."` —— 去掉外层引号
		if (cmd.length >= 2
			&& ((cmd.startsWith('"') && cmd.endsWith('"')) || (cmd.startsWith("'") && cmd.endsWith("'")))) {
			cmd = cmd.slice(1, -1).trim();
		}
		return cmd;
	}
	return cmd;
}

/**
 * 在一段文本里收集所有「像工具调用」的 JSON 对象。
 * @param {string} text
 * @param {object[]} out 收集目标
 * @param {object} [opts]
 * @param {boolean} [opts.requireCallShape] 只收集含 name/tool/function 键的对象
 * @returns {boolean} 是否收集到
 */
function collectJsonObjects(text, out, opts = {}) {
	let idx = 0;
	let got = false;
	while (idx < text.length) {
		const at = text.indexOf('{', idx);
		if (at === -1) break;
		const balanced = extractBalanced(text, at);
		if (balanced === null) { idx = at + 1; continue; }
		const obj = tryParseJson(balanced.text);
		if (obj !== null && !Array.isArray(obj)) {
			// 「像调用」的判据：有名字键，或者是只给了 shell 参数（`command`）的裸对象。
			// 后者实测很常见——模型省掉名字，直接给 {"command": "am start ..."}。
			const isCallShape = 'name' in obj || 'tool' in obj || 'function' in obj
				|| (typeof obj.command === 'string' && obj.command.length > 0);
			if (!opts.requireCallShape || isCallShape) {
				const call = normalizeCall(obj);
				if (call !== null) {
					out.push(call);
					got = true;
				}
			}
		}
		idx = balanced.end;
	}
	return got;
}

export { extractBalanced, normalizeCall, parseStringifiedCall };

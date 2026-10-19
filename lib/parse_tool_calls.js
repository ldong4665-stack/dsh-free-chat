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

	const name = obj.name ?? obj.tool ?? obj.function ?? obj.tool_name;
	if (typeof name !== 'string' || name.length === 0) return null;

	let args = obj.arguments ?? obj.parameters ?? obj.input ?? obj.args;
	if (args === undefined || args === null) args = {};
	if (typeof args === 'string') {
		const parsed = tryParseJson(args);
		args = parsed ?? { _: args };
	}
	if (typeof args !== 'object' || Array.isArray(args)) args = { _: String(args) };

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
		function: { name: m[1], arguments: JSON.stringify(args) },
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

	return null;
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
			const isCallShape = 'name' in obj || 'tool' in obj || 'function' in obj;
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

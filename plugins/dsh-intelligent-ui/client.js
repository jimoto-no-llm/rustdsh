/**
 * dsh-intelligent-ui — Client half.
 *
 * Registers two seats for one `render_ui` call:
 *
 * - `tool.call.toolview` replaces the call's own row, which streams the view
 *   while the call is being written.
 * - `conversation.chat.turnTail` contributes the settled view beside the answer,
 *   outside the Tool group — that group folds once the Turn closes, so the row
 *   alone would hide the view exactly when the answer is finished.
 *
 * The spec arrives on `block.meta` (the Host's `presentationMeta`), and falls
 * back to the call's `argsRaw` — which is what the PTC dispatch path needs, since
 * it projects no meta — and to the streaming prefix while the call is still being
 * written.
 *
 * Everything is drawn with plain React elements and the app's theme tokens: no
 * Harness Client package is imported (a plugin bundle gets only `react` from the
 * module table), and no untrusted HTML is ever injected. `calc` expressions run
 * on a hand-written parser over a fixed function whitelist — never `eval`.
 */

window.__ModuleLoader__.load({
	id: 'dsh-intelligent-ui',
	factory: (require) => {
		const React = require('react');
		/** Shorthand element factory: this bundle has no JSX build step. */
		const h = (type, props, ...children) => React.createElement(type, props, ...children);

		const VERSION = '0.3.0';
		const TOOL_NAME = 'render_ui';
		/** This bundle's module id, reused as the Turn-tail cell id. */
		const PLUGIN_ID = 'dsh-intelligent-ui';
		/** Class-name prefix, so plugin CSS cannot collide with the app's. */
		const P = 'dsh-iui';
		const NS = 'dsh-intelligent-ui';
		/** Client-side ceiling on rendered blocks; the Host caps a validated spec at 240 nodes. */
		const NODE_BUDGET = 400;
		/** Element types this half can draw; the Host's catalog is the authority. */
		const TYPES = [
			'section',
			'row',
			'text',
			'callout',
			'divider',
			'stat',
			'table',
			'chart',
			'comparison',
			'timeline',
			'diagram',
			'tabs',
			'inputs',
			'calc',
			'buttons'
		];

		// #region utilities

		function isPlainObject(value) {
			return value !== null && typeof value === 'object' && !Array.isArray(value);
		}

		/** A non-empty string, or undefined. */
		function asText(value) {
			return typeof value === 'string' && value !== '' ? value : undefined;
		}

		/** An array, or an empty array. */
		function asArray(value) {
			return Array.isArray(value) ? value : [];
		}

		/** A finite number, or undefined. */
		function asNumber(value) {
			return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
		}

		/** One of `values`, or the fallback. */
		function asEnum(value, values, fallback) {
			return values.includes(value) ? value : fallback;
		}

		/** Join truthy class names. */
		function cx(...names) {
			return names.filter(Boolean).join(' ');
		}

		/** Plain renderable text for a spec value. */
		function display(value) {
			if (value === undefined || value === null) return '';
			if (typeof value === 'boolean') return value ? '✓' : '—';
			return String(value);
		}

		// #endregion utilities

		// #region spec resolution

		/**
		 * Parse JSON that may be a truncated streaming prefix. A direct parse is
		 * tried first; otherwise the text is cut at the last structurally complete
		 * value, or an unterminated final string is closed, and the still-open
		 * brackets are closed again.
		 * @param text - raw argument text.
		 * @returns the parsed value, or undefined when nothing usable is there yet.
		 */
		function looseJson(text) {
			if (typeof text !== 'string') return undefined;
			const trimmed = text.trim();
			if (trimmed === '') return undefined;
			try {
				return JSON.parse(trimmed);
			} catch {
				/* repaired below */
			}
			const stack = [];
			let inString = false;
			let escaped = false;
			/** The last structural character seen outside a string. */
			let previous = '';
			/** Whether the string being read sits where a value belongs. */
			let isValueString = false;
			/** Every position where a complete value ended, newest last. */
			const cuts = [];
			const record = (at) => {
				cuts.push({ at, open: stack.slice() });
				if (cuts.length > 64) cuts.shift();
			};
			for (let index = 0; index < trimmed.length; index += 1) {
				const char = trimmed[index];
				if (inString) {
					if (escaped) escaped = false;
					else if (char === '\\') escaped = true;
					else if (char === '"') {
						inString = false;
						previous = '"';
						/* A key is not a value: cutting after one leaves a dangling key. */
						if (isValueString) record(index + 1);
					}
					continue;
				}
				if (char === '"') {
					inString = true;
					const container = stack[stack.length - 1];
					isValueString = previous === ':' || previous === '[' || previous === '' || (previous === ',' && container === ']');
					continue;
				}
				if (char === '{' || char === '[') {
					stack.push(char === '{' ? '}' : ']');
					previous = char;
					continue;
				}
				if (char === '}' || char === ']') {
					if (stack.length === 0) continue;
					stack.pop();
					record(index + 1);
					previous = char;
					continue;
				}
				if (char === ' ' || char === '\n' || char === '\r' || char === '\t') continue;
				if (char === ',' || char === ':') {
					previous = char;
					continue;
				}
				record(index + 1);
				previous = char;
			}
			/** The closers for a bracket stack, innermost first. */
			const close = (open) => open.slice().reverse().join('');
			if (inString && isValueString) {
				try {
					/* A half-written text value is shown as it stands. */
					return JSON.parse(`${trimmed.replace(/\\+$/, '')}"${close(stack)}`);
				} catch {
					/* fall through to the last complete value */
				}
			}
			/* Newest cut first: a half-written number keeps its complete prefix. */
			for (let index = cuts.length - 1; index >= 0; index -= 1) {
				try {
					return JSON.parse(`${trimmed.slice(0, cuts[index].at).replace(/[,:]\s*$/, '')}${close(cuts[index].open)}`);
				} catch {
					/* try an earlier boundary */
				}
			}
			return undefined;
		}

		/** Whether a value looks like a `render_ui` spec. */
		function looksLikeSpec(value) {
			return isPlainObject(value) && Array.isArray(value.blocks) && value.blocks.length > 0;
		}

		/**
		 * Keep only blocks this half can draw. A spec read from `argsRaw` has not
		 * been through the Host's validator (it may be a streaming prefix), so
		 * unusable blocks are dropped and reported instead of throwing.
		 * @param raw - candidate spec.
		 * @returns the spec to render, or undefined when nothing is drawable.
		 */
		function sanitizeSpec(raw) {
			if (!isPlainObject(raw) || !Array.isArray(raw.blocks)) return undefined;
			const dropped = [];
			const blocks = [];
			raw.blocks.forEach((block, index) => {
				if (!isPlainObject(block) || typeof block.type !== 'string' || RENDERERS[block.type] === undefined) {
					dropped.push(index);
					return;
				}
				blocks.push(block);
			});
			if (blocks.length === 0) return undefined;
			const spec = { blocks };
			const title = asText(raw.title);
			const summary = asText(raw.summary);
			if (title !== undefined) spec.title = title;
			if (summary !== undefined) spec.summary = summary;
			if (dropped.length > 0) spec.dropped = dropped;
			return spec;
		}

		/**
		 * Resolve the view for one call stage.
		 * @param phase - the block phase (`preparing`, `start`, or `result`).
		 * @param block - the call block or result node.
		 * @returns `{ state, spec?, source?, raw? }`.
		 */
		function specFromBlock(phase, block) {
			if (phase === 'result' && isPlainObject(block)) {
				const fromMeta = sanitizeSpec(block.meta);
				if (fromMeta !== undefined) return { state: 'ready', spec: fromMeta, source: 'meta' };
				const raw = block.call === null || block.call === undefined ? undefined : block.call.argsRaw;
				const fromArgs = sanitizeSpec(looseJson(raw));
				if (fromArgs !== undefined) return { state: 'ready', spec: fromArgs, source: 'args' };
				return { state: 'failed', raw: typeof raw === 'string' ? raw : '' };
			}
			if (phase === 'start' && isPlainObject(block)) {
				const raw = block.argsRaw;
				const fromArgs = sanitizeSpec(looseJson(raw));
				if (fromArgs !== undefined) return { state: 'ready', spec: fromArgs, source: 'args' };
				return { state: 'streaming', raw: typeof raw === 'string' ? raw : '' };
			}
			return { state: 'preparing' };
		}

		// #endregion spec resolution

		// #region calc expressions

		/** Fixed function whitelist for `calc.expr`. No member access, no other calls. */
		const FUNCTIONS = {
			min: Math.min,
			max: Math.max,
			abs: Math.abs,
			floor: Math.floor,
			ceil: Math.ceil,
			sqrt: Math.sqrt,
			pow: Math.pow,
			sum: (...values) => values.reduce((total, value) => total + value, 0),
			avg: (...values) => (values.length === 0 ? Number.NaN : values.reduce((total, value) => total + value, 0) / values.length),
			round: (value, digits = 0) => {
				const factor = 10 ** digits;
				return Math.round(value * factor) / factor;
			},
			if: (condition, whenTrue, whenFalse) => (condition ? whenTrue : whenFalse)
		};

		/** Split an expression into tokens, or throw with the offending text. */
		function tokenize(source) {
			const tokens = [];
			let index = 0;
			while (index < source.length) {
				const char = source[index];
				if (char === ' ' || char === '\n' || char === '\r' || char === '\t') {
					index += 1;
					continue;
				}
				if (char >= '0' && char <= '9') {
					let end = index;
					while (end < source.length && /[0-9.]/.test(source[end])) end += 1;
					const text = source.slice(index, end);
					const value = Number(text);
					if (!Number.isFinite(value)) throw new Error(`"${text}" is not a number`);
					tokens.push({ kind: 'number', value });
					index = end;
					continue;
				}
				if (char === '"' || char === "'") {
					let end = index + 1;
					let text = '';
					while (end < source.length && source[end] !== char) {
						if (source[end] === '\\' && end + 1 < source.length) {
							text += source[end + 1];
							end += 2;
							continue;
						}
						text += source[end];
						end += 1;
					}
					if (end >= source.length) throw new Error('a text literal is not closed');
					tokens.push({ kind: 'string', value: text });
					index = end + 1;
					continue;
				}
				if (/[A-Za-z_]/.test(char)) {
					let end = index;
					while (end < source.length && /[A-Za-z0-9_]/.test(source[end])) end += 1;
					tokens.push({ kind: 'name', value: source.slice(index, end) });
					index = end;
					continue;
				}
				const pair = source.slice(index, index + 2);
				if (['<=', '>=', '==', '!=', '&&', '||'].includes(pair)) {
					tokens.push({ kind: 'op', value: pair });
					index += 2;
					continue;
				}
				if ('+-*/%()?:!,<>'.includes(char)) {
					tokens.push({ kind: 'op', value: char });
					index += 1;
					continue;
				}
				throw new Error(`"${char}" cannot be used here`);
			}
			return tokens;
		}

		/** Recursive-descent parser over the token list. */
		function parseTokens(tokens) {
			let at = 0;
			const peek = () => tokens[at];
			const take = (value) => {
				const token = tokens[at];
				if (token === undefined || token.value !== value) throw new Error(`"${value}" is missing`);
				at += 1;
				return token;
			};
			const parsePrimary = () => {
				const token = peek();
				if (token === undefined) throw new Error('the expression ends early');
				if (token.kind === 'number' || token.kind === 'string') {
					at += 1;
					return { kind: 'literal', value: token.value };
				}
				if (token.kind === 'name') {
					at += 1;
					if (peek() !== undefined && peek().value === '(') {
						if (!Object.hasOwn(FUNCTIONS, token.value)) throw new Error(`"${token.value}" is not one of the allowed functions`);
						take('(');
						const args = [];
						if (peek() !== undefined && peek().value !== ')') {
							args.push(parseExpression());
							while (peek() !== undefined && peek().value === ',') {
								take(',');
								args.push(parseExpression());
							}
						}
						take(')');
						return { kind: 'call', name: token.value, args };
					}
					if (token.value === 'true' || token.value === 'false' || token.value === 'null')
						return { kind: 'literal', value: token.value === 'true' ? true : token.value === 'false' ? false : null };
					return { kind: 'name', name: token.value };
				}
				if (token.value === '(') {
					take('(');
					const inner = parseExpression();
					take(')');
					return inner;
				}
				if (token.value === '-' || token.value === '+' || token.value === '!') {
					at += 1;
					return { kind: 'unary', op: token.value, operand: parsePrimary() };
				}
				throw new Error(`"${token.value}" cannot start a value`);
			};
			const parseBinary = (operators, next) => () => {
				let left = next();
				for (;;) {
					const token = peek();
					if (token === undefined || !operators.includes(token.value)) return left;
					at += 1;
					left = { kind: 'binary', op: token.value, left, right: next() };
				}
			};
			const parseUnary = () => {
				const token = peek();
				if (token !== undefined && (token.value === '-' || token.value === '+' || token.value === '!')) {
					at += 1;
					return { kind: 'unary', op: token.value, operand: parseUnary() };
				}
				return parsePrimary();
			};
			const parseMultiplicative = parseBinary(['*', '/', '%'], parseUnary);
			const parseAdditive = parseBinary(['+', '-'], parseMultiplicative);
			const parseRelational = parseBinary(['<', '<=', '>', '>='], parseAdditive);
			const parseEquality = parseBinary(['==', '!=', '===', '!=='], parseRelational);
			const parseAnd = parseBinary(['&&'], parseEquality);
			const parseOr = parseBinary(['||'], parseAnd);
			function parseExpression() {
				const condition = parseOr();
				const token = peek();
				if (token !== undefined && token.value === '?') {
					take('?');
					const whenTrue = parseExpression();
					take(':');
					const whenFalse = parseExpression();
					return { kind: 'conditional', condition, whenTrue, whenFalse };
				}
				return condition;
			}
			const ast = parseExpression();
			if (at !== tokens.length) throw new Error(`"${tokens[at].value}" is unexpected`);
			return ast;
		}

		/** Compile an expression once; `{ ast }` or `{ error }`. */
		function compileExpr(source) {
			if (typeof source !== 'string') return { error: 'no expression' };
			try {
				return { ast: parseTokens(tokenize(source)) };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		}

		/** Evaluate a compiled expression against input values. */
		function evalNode(node, scope) {
			switch (node.kind) {
				case 'literal':
					return node.value;
				case 'name':
					if (!Object.hasOwn(scope, node.name)) throw new Error(`"${node.name}" is not a declared input`);
					return scope[node.name];
				case 'unary': {
					const operand = evalNode(node.operand, scope);
					if (node.op === '!') return !operand;
					if (node.op === '-') return -operand;
					return +operand;
				}
				case 'binary': {
					if (node.op === '&&') return evalNode(node.left, scope) && evalNode(node.right, scope);
					if (node.op === '||') return evalNode(node.left, scope) || evalNode(node.right, scope);
					const left = evalNode(node.left, scope);
					const right = evalNode(node.right, scope);
					switch (node.op) {
						case '+':
							return typeof left === 'string' || typeof right === 'string' ? `${left}${right}` : left + right;
						case '-':
							return left - right;
						case '*':
							return left * right;
						case '/':
							return left / right;
						case '%':
							return left % right;
						case '<':
							return left < right;
						case '<=':
							return left <= right;
						case '>':
							return left > right;
						case '>=':
							return left >= right;
						case '==':
						case '===':
							return left === right;
						default:
							return left !== right;
					}
				}
				case 'conditional':
					return evalNode(node.condition, scope) ? evalNode(node.whenTrue, scope) : evalNode(node.whenFalse, scope);
				default: {
					const args = node.args.map((arg) => evalNode(arg, scope));
					return FUNCTIONS[node.name](...args);
				}
			}
		}

		/**
		 * Run a compiled expression.
		 * @param compiled - the result of {@link compileExpr}.
		 * @param scope - declared input values by name.
		 * @returns `{ value }` or `{ error }`; a non-finite result is an error.
		 */
		function runExpr(compiled, scope) {
			if (compiled.error !== undefined) return { error: compiled.error };
			try {
				const value = evalNode(compiled.ast, scope);
				if (typeof value === 'number') {
					if (!Number.isFinite(value)) return { error: 'the result is not a finite number' };
					return { value };
				}
				if (typeof value === 'string' || typeof value === 'boolean') return { value };
				return { error: 'the result is not a value' };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error) };
			}
		}

		/** Format a number for display, honouring `calc.format` and table `format`. */
		function formatValue(value, format, locale) {
			const options = isPlainObject(format) ? format : {};
			const decimals = asNumber(options.decimals);
			let number = value;
			let suffix = asText(options.suffix) ?? '';
			if (options.percent === true) {
				number *= 100;
				if (suffix === '') suffix = '%';
			}
			const shown = Number.isFinite(number)
				? number.toLocaleString(locale, {
						minimumFractionDigits: decimals ?? 0,
						maximumFractionDigits: decimals ?? 2
					})
				: display(number);
			return `${asText(options.prefix) ?? ''}${shown}${suffix}`;
		}

		// #endregion calc expressions

		// #region chart scale

		/**
		 * A round axis maximum for the data, with round steps between the ticks.
		 * @param rawMax - the largest value to fit.
		 * @returns the axis maximum and the tick values from zero up to it.
		 */
		function niceTicks(rawMax) {
			if (!(rawMax > 0)) return { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
			const rough = rawMax / 4;
			const magnitude = 10 ** Math.floor(Math.log10(rough));
			const residual = rough / magnitude;
			const step = (residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 2.5 ? 2.5 : residual <= 5 ? 5 : 10) * magnitude;
			/* Binary floating point turns 3 * 0.2 into 0.6000000000000001. */
			const round = (value) => Number(value.toPrecision(12));
			const max = round(Math.ceil(rawMax / step) * step);
			const ticks = [];
			for (let index = 0; index * step <= max + step / 2; index += 1) ticks.push(round(index * step));
			return { max, ticks };
		}

		// #endregion chart scale

		// #region view state

		/** Declared input values, seeded from the field defaults. */
		function initialValues(spec) {
			const values = {};
			const visit = (blocks) => {
				for (const block of asArray(blocks)) {
					if (block.type === 'inputs') {
						for (const field of asArray(block.fields)) {
							const name = asText(field.name);
							if (name === undefined || Object.hasOwn(values, name)) continue;
							if (field.kind === 'checkbox') values[name] = field.value === true;
							else if (field.kind === 'number' || field.kind === 'range')
								values[name] = asNumber(field.value) ?? asNumber(field.min) ?? 0;
							else if (field.kind === 'select') {
								const options = asArray(field.options);
								const chosen = asText(field.value) ?? (options.length > 0 ? asText(options[0].value) : undefined);
								values[name] = chosen ?? '';
							} else values[name] = asText(field.value) ?? '';
						}
					}
					visit(block.blocks);
					for (const tab of asArray(block.tabs)) visit(tab.blocks);
				}
			};
			visit(spec.blocks);
			return values;
		}

		/** Replace `{{name}}` with the current value; a select substitutes its label. */
		function interpolate(template, spec, values) {
			if (typeof template !== 'string') return '';
			return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (whole, name) => {
				if (!Object.hasOwn(values, name)) return whole;
				const option = findField(spec, name);
				if (option !== undefined && option.kind === 'select') {
					const match = asArray(option.options).find((entry) => entry.value === values[name]);
					if (match !== undefined) return display(match.label ?? match.value);
				}
				return display(values[name]);
			});
		}

		/** The field declaration named `name`, anywhere in the spec. */
		function findField(spec, name) {
			let found;
			const visit = (blocks) => {
				for (const block of asArray(blocks)) {
					if (found !== undefined) return;
					if (block.type === 'inputs')
						found = asArray(block.fields).find((field) => asText(field.name) === name);
					visit(block.blocks);
					for (const tab of asArray(block.tabs)) visit(tab.blocks);
				}
			};
			visit(spec.blocks);
			return found;
		}

		// #endregion view state

		// #region elements

		/** Blocks render in order; nothing throws past a single failed block. */
		function renderBlocks(blocks, rc) {
			if (!Array.isArray(blocks)) return null;
			const out = [];
			for (let index = 0; index < blocks.length; index += 1) {
				if (rc.budget.left <= 0) {
					out.push(h('div', { key: `omitted-${index}`, className: `${P}-omitted` }, rc.t('omittedBlocks', { count: blocks.length - index })));
					break;
				}
				rc.budget.left -= 1;
				const block = blocks[index];
				const Renderer = isPlainObject(block) ? RENDERERS[block.type] : undefined;
				if (Renderer === undefined) continue;
				out.push(
					h(
						BlockBoundary,
						{ key: `block-${index}`, type: block.type, t: rc.t },
						h(Renderer, { block, rc: { ...rc, depth: rc.depth + 1 } })
					)
				);
			}
			return out;
		}

		/** A titled group. */
		function SectionBlock({ block, rc }) {
			const title = asText(block.title);
			const subtitle = asText(block.subtitle);
			return h(
				'section',
				{ className: `${P}-section` },
				title === undefined ? null : h('h4', { className: `${P}-section-title` }, title),
				subtitle === undefined ? null : h('p', { className: `${P}-section-subtitle` }, subtitle),
				h('div', { className: `${P}-section-body` }, renderBlocks(block.blocks, rc))
			);
		}

		/** Side-by-side blocks. */
		function RowBlock({ block, rc }) {
			return h('div', { className: `${P}-row` }, renderBlocks(block.blocks, rc));
		}

		/** A paragraph. */
		function TextBlock({ block }) {
			const style = asEnum(block.style, ['body', 'lead', 'caption'], 'body');
			return h('p', { className: cx(`${P}-text`, `${P}-text-${style}`) }, display(block.text));
		}

		/** A toned note. */
		function CalloutBlock({ block }) {
			const tone = asEnum(block.tone, ['info', 'success', 'warn', 'error'], 'info');
			const title = asText(block.title);
			return h(
				'div',
				{ className: cx(`${P}-callout`, `${P}-callout-${tone}`) },
				title === undefined ? null : h('div', { className: `${P}-callout-title` }, title),
				h('div', { className: `${P}-callout-text` }, display(block.text))
			);
		}

		/** A rule. */
		function DividerBlock() {
			return h('hr', { className: `${P}-divider` });
		}

		/** One number that matters. */
		function StatBlock({ block, rc }) {
			const delta = asText(block.delta);
			const hint = asText(block.hint);
			const value = typeof block.value === 'number' ? block.value.toLocaleString(rc.locale, { maximumFractionDigits: 2 }) : display(block.value);
			return h(
				'div',
				{ className: `${P}-stat` },
				h('div', { className: `${P}-stat-label` }, display(block.label)),
				h('div', { className: `${P}-stat-value` }, value),
				delta === undefined ? null : h('div', { className: `${P}-stat-delta` }, delta),
				hint === undefined ? null : h('div', { className: `${P}-stat-hint` }, hint)
			);
		}

		/** A sortable table. */
		function TableBlock({ block, rc }) {
			const columns = asArray(block.columns).filter((column) => isPlainObject(column));
			const rows = asArray(block.rows).filter((row) => isPlainObject(row));
			const sortable = block.sortable === true;
			const [sort, setSort] = React.useState(() => {
				const initial = isPlainObject(block.initialSort) ? block.initialSort : undefined;
				if (initial === undefined) return null;
				const key = asText(initial.key);
				if (key === undefined) return null;
				return { key, dir: asEnum(initial.dir, ['asc', 'desc'], 'asc') };
			});
			const ordered = React.useMemo(() => {
				if (sort === null) return rows;
				const sign = sort.dir === 'asc' ? 1 : -1;
				return rows
					.map((row, index) => ({ row, index }))
					.sort((left, right) => {
						const a = left.row[sort.key];
						const b = right.row[sort.key];
						if (typeof a === 'number' && typeof b === 'number') return (a - b) * sign;
						const compared = display(a).localeCompare(display(b), rc.locale);
						return (compared === 0 ? left.index - right.index : compared) * sign;
					})
					.map((entry) => entry.row);
			}, [rows, sort, rc.locale]);
			const toggle = (key) =>
				setSort((current) =>
					current !== null && current.key === key
						? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
						: { key, dir: 'asc' }
				);
			const cell = (column, row) => {
				const value = row[column.key];
				const format = column.format;
				if (format === 'number' || format === 'percent') return formatValue(asNumber(value) ?? 0, { percent: format === 'percent' }, rc.locale);
				return display(value);
			};
			return h(
				'div',
				{ className: `${P}-table-wrap` },
				asText(block.title) === undefined ? null : h('div', { className: `${P}-block-title` }, block.title),
				h(
					'table',
					{ className: `${P}-table` },
					h(
						'thead',
						null,
						h(
							'tr',
							null,
							columns.map((column, index) =>
								h(
									'th',
									{
										key: index,
										style: { textAlign: asEnum(column.align, ['left', 'right', 'center'], 'left') },
										'aria-sort': sort !== null && sort.key === column.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined
									},
									sortable
										? h(
												'button',
												{
													type: 'button',
													className: `${P}-th-button`,
													onClick: () => toggle(column.key)
												},
												display(column.label),
												sort !== null && sort.key === column.key ? h('span', { className: `${P}-sort-mark` }, sort.dir === 'asc' ? '▲' : '▼') : null
											)
										: display(column.label)
								)
							)
						)
					),
					h(
						'tbody',
						null,
						ordered.map((row, rowIndex) =>
							h(
								'tr',
								{ key: rowIndex },
								columns.map((column, columnIndex) =>
									h(
										'td',
										{ key: columnIndex, style: { textAlign: asEnum(column.align, ['left', 'right', 'center'], 'left') } },
										cell(column, row)
									)
								)
							)
						)
					)
				)
			);
		}

		/** Series colours, resolved from theme tokens in the stylesheet. */
		const PALETTE = ['--dsh-iui-series-1', '--dsh-iui-series-2', '--dsh-iui-series-3', '--dsh-iui-series-4', '--dsh-iui-series-5'];

		/** A series colour from the theme, or the palette at that index. */
		function seriesColor(series, index) {
			const declared = series.color;
			return typeof declared === 'string' && declared.startsWith('--') ? `var(${declared})` : `var(${PALETTE[index % PALETTE.length]})`;
		}

		/** Bar, line, and pie charts as inline SVG. */
		function ChartBlock({ block, rc }) {
			const kind = asEnum(block.kind, ['bar', 'line', 'pie'], 'bar');
			const categories = asArray(block.categories).map((entry) => display(entry));
			const series = asArray(block.series)
				.filter((entry) => isPlainObject(entry))
				.map((entry) => ({ label: display(entry.label), data: asArray(entry.data).map((value) => asNumber(value) ?? 0), color: entry.color }));
			const width = 320;
			const height = 170;
			const pad = { top: 10, right: 10, bottom: 22, left: 34 };
			const plotWidth = width - pad.left - pad.right;
			const plotHeight = height - pad.top - pad.bottom;
			const stacked = block.stacked === true;
			const totals = categories.map((_, index) =>
				stacked ? series.reduce((sum, entry) => sum + Math.max(0, entry.data[index] ?? 0), 0) : Math.max(...series.map((entry) => entry.data[index] ?? 0), 0)
			);
			const rawMax = Math.max(...totals, 0);
			const { max, ticks } = niceTicks(rawMax);
			const y = (value) => pad.top + plotHeight - (value / max) * plotHeight;

			if (kind === 'pie') {
				const entry = series[0] ?? { data: [], label: '' };
				const values = categories.map((_, index) => Math.max(0, entry.data[index] ?? 0));
				const total = values.reduce((sum, value) => sum + value, 0);
				const radius = Math.min(width, height) / 2 - 12;
				const centre = { x: width / 2, y: height / 2 };
				let angle = -Math.PI / 2;
				const slices = values.map((value, index) => {
					const sweep = total === 0 ? 0 : (value / total) * Math.PI * 2;
					const start = angle;
					const end = angle + sweep;
					angle = end;
					const large = sweep > Math.PI ? 1 : 0;
					return {
						key: index,
						label: categories[index],
						value,
						path: `M ${centre.x} ${centre.y} L ${centre.x + Math.cos(start) * radius} ${centre.y + Math.sin(start) * radius} A ${radius} ${radius} 0 ${large} 1 ${
							centre.x + Math.cos(end) * radius
						} ${centre.y + Math.sin(end) * radius} Z`,
						color: `var(${PALETTE[index % PALETTE.length]})`
					};
				});
				return h(
					'div',
					{ className: `${P}-chart` },
					asText(block.title) === undefined ? null : h('div', { className: `${P}-block-title` }, block.title),
					h(
						'svg',
						{ viewBox: `0 0 ${width} ${height}`, className: `${P}-svg`, role: 'img', 'aria-label': asText(block.title) ?? block.kind },
						slices.map((slice) => h('path', { key: slice.key, d: slice.path, fill: slice.color, className: `${P}-slice` }, h('title', null, `${slice.label}: ${display(slice.value)}`)))
					),
					h(
						'ul',
						{ className: `${P}-legend` },
						slices.map((slice) =>
							h(
								'li',
								{ key: slice.key, className: `${P}-legend-item` },
								h('span', { className: `${P}-swatch`, style: { background: slice.color } }),
								`${slice.label} ${total === 0 ? '' : `${Math.round((slice.value / total) * 100)}%`}`.trim()
							)
						)
					)
				);
			}

			const groupWidth = plotWidth / Math.max(1, categories.length);
			const barWidth = stacked ? groupWidth * 0.5 : (groupWidth * 0.7) / Math.max(1, series.length);
			const bars = [];
			if (kind === 'bar') {
				categories.forEach((category, index) => {
					let stackTop = 0;
					series.forEach((entry, seriesIndex) => {
						const value = Math.max(0, entry.data[index] ?? 0);
						const barHeight = (value / max) * plotHeight;
						const x = stacked
							? pad.left + index * groupWidth + (groupWidth - barWidth) / 2
							: pad.left + index * groupWidth + groupWidth * 0.15 + seriesIndex * barWidth;
						const yTop = stacked ? y(stackTop + value) : y(value);
						stackTop += value;
						bars.push(
							h('rect', {
								key: `${index}-${seriesIndex}`,
								x,
								y: yTop,
								width: Math.max(1, barWidth - 1),
								height: Math.max(0, pad.top + plotHeight - yTop),
								rx: 2,
								fill: seriesColor(entry, seriesIndex),
								className: `${P}-bar`
							})
						);
					});
				});
			}
			const lines =
				kind === 'line'
					? series.map((entry, seriesIndex) =>
							h(
								'g',
								{ key: seriesIndex },
								h(
									'polyline',
									{
										points: categories
											.map((_, index) => `${pad.left + index * groupWidth + groupWidth / 2},${y(entry.data[index] ?? 0)}`)
											.join(' '),
										fill: 'none',
										stroke: seriesColor(entry, seriesIndex),
										'stroke-width': 1.8,
										'stroke-linejoin': 'round'
									}
								),
								categories.map((category, index) =>
									h('circle', {
										key: index,
										cx: pad.left + index * groupWidth + groupWidth / 2,
										cy: y(entry.data[index] ?? 0),
										r: 2.4,
										fill: seriesColor(entry, seriesIndex)
									})
								)
							)
						)
					: [];

			return h(
				'div',
				{ className: `${P}-chart` },
				asText(block.title) === undefined && asText(block.yLabel) === undefined
					? null
					: h(
							'div',
							{ className: `${P}-block-head` },
							asText(block.title) === undefined ? null : h('div', { className: `${P}-block-title` }, block.title),
							asText(block.yLabel) === undefined ? null : h('div', { className: `${P}-axis-caption` }, block.yLabel)
						),
				h(
					'svg',
					{ viewBox: `0 0 ${width} ${height}`, className: `${P}-svg`, role: 'img', 'aria-label': asText(block.title) ?? block.kind },
					ticks.map((tick, index) =>
						h(
							'g',
							{ key: index },
							h('line', {
								x1: pad.left,
								x2: width - pad.right,
								y1: y(tick),
								y2: y(tick),
								className: `${P}-grid`
							}),
							h(
								'text',
								{ x: pad.left - 4, y: y(tick) + 3, className: `${P}-axis-tick`, textAnchor: 'end' },
								tick.toLocaleString(rc.locale, { maximumFractionDigits: 2 })
							)
						)
					),
					bars,
					lines,
					categories.map((category, index) =>
						h(
							'text',
							{
								key: index,
								x: pad.left + index * groupWidth + groupWidth / 2,
								y: height - 6,
								className: `${P}-axis-tick`,
								textAnchor: 'middle'
							},
							category
						)
					)
				),
				series.length > 1
					? h(
							'ul',
							{ className: `${P}-legend` },
							series.map((entry, index) =>
								h(
									'li',
									{ key: index, className: `${P}-legend-item` },
									h('span', { className: `${P}-swatch`, style: { background: seriesColor(entry, index) } }),
									entry.label
								)
							)
						)
					: null
			);
		}

		/** Options side by side. */
		function ComparisonBlock({ block }) {
			const columns = asArray(block.columns).filter((column) => isPlainObject(column));
			const rows = asArray(block.rows).filter((row) => isPlainObject(row));
			return h(
				'div',
				{ className: `${P}-comparison` },
				asText(block.title) === undefined ? null : h('div', { className: `${P}-block-title` }, block.title),
				h(
					'div',
					{ className: `${P}-comparison-grid`, style: { gridTemplateColumns: `minmax(70px, 1fr) repeat(${columns.length}, minmax(0, 1.2fr))` } },
					h('div', { className: `${P}-comparison-corner` }),
					columns.map((column, index) =>
						h(
							'div',
							{ key: index, className: `${P}-comparison-head` },
							display(column.label),
							asText(column.hint) === undefined ? null : h('span', { className: `${P}-comparison-hint` }, column.hint)
						)
					),
					rows.flatMap((row, rowIndex) => [
						h('div', { key: `a${rowIndex}`, className: `${P}-comparison-attribute` }, display(row.attribute)),
						...columns.map((_, columnIndex) =>
							h('div', { key: `v${rowIndex}-${columnIndex}`, className: `${P}-comparison-value` }, display(asArray(row.values)[columnIndex]))
						)
					])
				)
			);
		}

		/** Ordered steps. */
		function TimelineBlock({ block }) {
			return h(
				'div',
				{ className: `${P}-timeline-wrap` },
				asText(block.title) === undefined ? null : h('div', { className: `${P}-block-title` }, block.title),
				h(
					'ol',
					{ className: `${P}-timeline` },
					asArray(block.items)
						.filter((item) => isPlainObject(item))
						.map((item, index) =>
							h(
								'li',
								{ key: index, className: `${P}-timeline-item` },
								h('span', { className: `${P}-timeline-dot`, 'aria-hidden': 'true' }),
								h(
									'div',
									{ className: `${P}-timeline-body` },
									h(
										'div',
										{ className: `${P}-timeline-head` },
										h('span', { className: `${P}-timeline-label` }, display(item.label)),
										asText(item.at) === undefined ? null : h('span', { className: `${P}-timeline-at` }, item.at)
									),
									asText(item.detail) === undefined ? null : h('div', { className: `${P}-timeline-detail` }, item.detail)
								)
							)
						)
				)
			);
		}

		/** Rendered width of a label in viewBox units, at the edge-label font size. */
		function labelUnits(text) {
			return [...String(text)].reduce((sum, ch) => sum + (/[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 9 : 5), 0);
		}

		/** A label trimmed so `units(label) <= max`. */
		function fitUnits(text, max) {
			let used = 0;
			let out = '';
			for (const ch of String(text)) {
				const units = /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 9 : 5;
				if (used + units > max) return `${out}…`;
				used += units;
				out += ch;
			}
			return String(text);
		}

		/** How far inside a node border an edge stops, so the stroke always meets the box. */
		const EDGE_INSET = 1.5;
		/** Padding between an edge label and the two line pieces it interrupts. */
		const LABEL_PAD = 4;
		/** Shortest line piece worth drawing on either side of an on-line label. */
		const LABEL_MIN_PIECE = 6;
		/** Distance from the line for a label too wide to sit on it. */
		const LABEL_ASIDE = 8;

		/**
		 * Geometry for one edge: the line between two node boxes, split only when its
		 * label fits whole in the gap. An edge that cannot carry its label on the line
		 * stays in one piece and hangs the label beside it, so no edge is ever left
		 * dangling in mid-air. Returns `undefined` when the two ends coincide.
		 *
		 * @param from - centre of the source node, in viewBox units.
		 * @param to - centre of the target node, in viewBox units.
		 * @param box - node box size.
		 * @param rawLabel - the edge label, when it has one.
		 */
		function diagramEdge(from, to, box, rawLabel) {
			const dx = to.x - from.x;
			const dy = to.y - from.y;
			const distance = Math.hypot(dx, dy);
			if (distance < 1) return undefined;
			const ux = dx / distance;
			const uy = dy / distance;
			/* Distance from a box centre to its border, along the edge direction. */
			const reach = Math.min(
				ux === 0 ? Infinity : box.width / 2 / Math.abs(ux),
				uy === 0 ? Infinity : box.height / 2 / Math.abs(uy)
			);
			/*
			 * Stop just inside the border (the boxes are drawn over the edges) and never
			 * past the midpoint, so a short edge can never turn its two ends around.
			 */
			const trim = Math.min(Math.max(0, reach - EDGE_INSET), Math.max(0, distance / 2 - 0.5));
			const start = { x: from.x + ux * trim, y: from.y + uy * trim };
			const end = { x: to.x - ux * trim, y: to.y - uy * trim };
			const mid = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
			const room = distance - 2 * trim;
			/* The label only takes the line when it still leaves a piece on both sides. */
			const onLine = rawLabel !== undefined && labelUnits(rawLabel) + LABEL_PAD * 2 + LABEL_MIN_PIECE * 2 <= room;
			const half = onLine ? labelUnits(rawLabel) / 2 + LABEL_PAD : 0;
			return {
				start,
				end,
				/** The first piece: the whole edge unless a label sits on the line. */
				head: onLine ? { x: mid.x - ux * half, y: mid.y - uy * half } : end,
				/** The closing piece, drawn only under an on-line label. */
				tail: onLine ? { x: mid.x + ux * half, y: mid.y + uy * half } : undefined,
				label:
					rawLabel === undefined
						? undefined
						: {
								text: onLine ? rawLabel : fitUnits(rawLabel, 120),
								x: mid.x + (onLine ? 0 : uy * LABEL_ASIDE),
								y: mid.y + (onLine ? 0 : -ux * LABEL_ASIDE) + 3
							}
			};
		}

		/** Nodes and edges; selecting a node reveals its detail. */
		function DiagramBlock({ block, rc }) {
			const layout = asEnum(block.layout, ['flow', 'tree', 'cycle'], 'flow');
			const nodes = asArray(block.nodes).filter((node) => isPlainObject(node));
			const edges = asArray(block.edges).filter((edge) => isPlainObject(edge));
			const [selected, setSelected] = React.useState(null);
			const box = { width: 84, height: 30 };
			const perRowCap = 4;
			const slotGap = 64;
			const slots = Math.max(1, Math.min(nodes.length || 1, perRowCap));
			const width = slots * (box.width + slotGap);
			const rows = Math.max(1, Math.ceil((nodes.length || 1) / perRowCap));
			const cycleRadius = Math.min(Math.max(56, (box.width + 14) / (2 * Math.sin(Math.PI / Math.max(2, nodes.length)))), 96);
			const height = layout === 'cycle' ? 2 * cycleRadius + box.height + 40 : 14 + rows * (box.height + 34);
			const positions = new Map();
			if (layout === 'cycle') {
				nodes.forEach((node, index) => {
					const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2 - Math.PI / 2;
					positions.set(node.id, {
						x: width / 2 + Math.cos(angle) * cycleRadius - box.width / 2,
						y: height / 2 + Math.sin(angle) * cycleRadius - box.height / 2
					});
				});
			} else {
				nodes.forEach((node, index) => {
					const row = Math.floor(index / perRowCap);
					const inRow = Math.min(perRowCap, nodes.length - row * perRowCap);
					const column = index % perRowCap;
					positions.set(node.id, {
						x: ((column + 0.5) * width) / inRow - box.width / 2,
						y: 14 + row * (box.height + 34)
					});
				});
			}
			const centreOf = (id) => {
				const at = positions.get(id);
				return at === undefined ? undefined : { x: at.x + box.width / 2, y: at.y + box.height / 2 };
			};
			/** A node label trimmed to the node box, so it never spills over the border. */
			const fitNodeLabel = (value) => {
				const text = display(value);
				let used = 0;
				let out = '';
				for (const ch of text) {
					const units = /[\u2e80-\u9fff\uff00-\uffef]/.test(ch) ? 10 : 5.6;
					if (used + units > box.width - 12) return `${out}…`;
					used += units;
					out += ch;
				}
				return text;
			};
			const chosen = nodes.find((node) => node.id === selected);
			return h(
				'div',
				{ className: `${P}-diagram` },
				asText(block.title) === undefined ? null : h('div', { className: `${P}-block-title` }, block.title),
				h(
					'svg',
					{ viewBox: `0 0 ${width} ${height}`, className: `${P}-svg`, role: 'img', 'aria-label': asText(block.title) ?? 'diagram' },
					edges.map((edge, index) => {
						const from = centreOf(edge.from);
						const to = centreOf(edge.to);
						if (from === undefined || to === undefined) return null;
						const geometry = diagramEdge(from, to, box, asText(edge.label));
						if (geometry === undefined) return null;
						return h(
							'g',
							{ key: index },
							h('line', {
								x1: geometry.start.x,
								y1: geometry.start.y,
								x2: geometry.head.x,
								y2: geometry.head.y,
								className: `${P}-edge`
							}),
							geometry.tail === undefined
								? null
								: h('line', {
										x1: geometry.tail.x,
										y1: geometry.tail.y,
										x2: geometry.end.x,
										y2: geometry.end.y,
										className: `${P}-edge`
									}),
							geometry.label === undefined
								? null
								: h(
										'text',
										{
											x: geometry.label.x,
											y: geometry.label.y,
											className: `${P}-edge-label`,
											textAnchor: 'middle'
										},
										geometry.label.text
									)
						);
					}),
					nodes.map((node, index) => {
						const at = positions.get(node.id) ?? { x: 0, y: 0 };
						const active = node.id === selected;
						return h(
							'g',
							{
								key: index,
								className: cx(`${P}-node`, active && `${P}-node-active`),
								role: 'button',
								tabIndex: 0,
								'aria-label': display(node.label),
								onClick: () => setSelected(active ? null : node.id),
								onKeyDown: (event) => {
									if (event.key === 'Enter' || event.key === ' ') {
										event.preventDefault();
										setSelected(active ? null : node.id);
									}
								}
							},
							h('rect', { x: at.x, y: at.y, width: box.width, height: box.height, rx: 7, className: `${P}-node-box` }),
							h(
								'text',
								{ x: at.x + box.width / 2, y: at.y + box.height / 2 + 4, className: `${P}-node-label`, textAnchor: 'middle' },
								fitNodeLabel(node.label)
							)
						);
					})
				),
				chosen === undefined
					? rc.t('diagramHint')
					: h(
							'div',
							{ className: `${P}-node-detail` },
							h('strong', null, display(chosen.label)),
							asText(chosen.detail) === undefined ? null : h('span', null, chosen.detail)
						)
			);
		}

		/** Parallel answers, one panel at a time. */
		function TabsBlock({ block, rc }) {
			const tabs = asArray(block.tabs).filter((tab) => isPlainObject(tab));
			const [active, setActive] = React.useState(0);
			if (tabs.length === 0) return null;
			const index = Math.min(active, tabs.length - 1);
			return h(
				'div',
				{ className: `${P}-tabs` },
				h(
					'div',
					{ className: `${P}-tablist`, role: 'tablist' },
					tabs.map((tab, tabIndex) =>
						h(
							'button',
							{
								key: tabIndex,
								type: 'button',
								role: 'tab',
								'aria-selected': tabIndex === index,
								className: cx(`${P}-tab`, tabIndex === index && `${P}-tab-active`),
								onClick: () => setActive(tabIndex)
							},
							display(tab.label)
						)
					)
				),
				h('div', { className: `${P}-tabpanel`, role: 'tabpanel' }, renderBlocks(tabs[index].blocks, rc))
			);
		}

		/** Named inputs the user can change; `calc` and messages read them. */
		function InputsBlock({ block, rc }) {
			const fields = asArray(block.fields).filter((field) => isPlainObject(field));
			const set = (name, value) => rc.setValue(name, value);
			const control = (field, index) => {
				const name = asText(field.name) ?? `field${index}`;
				const value = rc.values[name];
				const common = {
					id: `${P}-${rc.instance}-${name}`,
					className: `${P}-control`,
					'aria-label': display(field.label)
				};
				switch (field.kind) {
					case 'textarea':
						return h('textarea', { ...common, rows: 3, value: display(value), placeholder: asText(field.placeholder), onChange: (event) => set(name, event.target.value) });
					case 'number':
						return h('input', {
							...common,
							type: 'number',
							value: display(value),
							min: asNumber(field.min),
							max: asNumber(field.max),
							step: asNumber(field.step),
							onChange: (event) => set(name, event.target.value === '' ? '' : Number(event.target.value))
						});
					case 'range':
						return h(
							'div',
							{ className: `${P}-range` },
							h('input', {
								...common,
								type: 'range',
								value: asNumber(value) ?? 0,
								min: asNumber(field.min) ?? 0,
								max: asNumber(field.max) ?? 100,
								step: asNumber(field.step) ?? 1,
								onChange: (event) => set(name, Number(event.target.value))
							}),
							h('span', { className: `${P}-range-value` }, display(value))
						);
					case 'select':
						return h(
							'select',
							{ ...common, value: display(value), onChange: (event) => set(name, event.target.value) },
							asArray(field.options).map((option, optionIndex) =>
								h('option', { key: optionIndex, value: display(option.value) }, display(option.label))
							)
						);
					case 'checkbox':
						return h('input', {
							...common,
							type: 'checkbox',
							checked: value === true,
							onChange: (event) => set(name, event.target.checked)
						});
					default:
						return h('input', { ...common, type: 'text', value: display(value), placeholder: asText(field.placeholder), onChange: (event) => set(name, event.target.value) });
				}
			};
			const submit = isPlainObject(block.submit) ? block.submit : undefined;
			return h(
				'div',
				{ className: `${P}-inputs` },
				asText(block.title) === undefined ? null : h('div', { className: `${P}-block-title` }, block.title),
				fields.map((field, index) => {
					const checkbox = field.kind === 'checkbox';
					return h(
						'div',
						{ key: index, className: cx(`${P}-field`, checkbox && `${P}-field-inline`) },
						h('label', { className: `${P}-field-label`, htmlFor: `${P}-${rc.instance}-${asText(field.name) ?? index}` }, display(field.label)),
						control(field, index),
						asText(field.hint) === undefined ? null : h('div', { className: `${P}-field-hint` }, field.hint)
					);
				}),
				submit === undefined
					? null
					: h(
							'div',
							{ className: `${P}-actions` },
							h(
								'button',
								{
									type: 'button',
									className: `${P}-button ${P}-button-primary`,
									onClick: () => rc.send(interpolate(submit.message, rc.spec, rc.values))
								},
								display(submit.label)
							)
						)
			);
		}

		/** A value recomputed from the current inputs. */
		function CalcBlock({ block, rc }) {
			const compiled = React.useMemo(() => compileExpr(block.expr), [block.expr]);
			const result = runExpr(compiled, rc.values);
			const hint = asText(block.hint);
			const shown =
				result.error !== undefined ? '—' : typeof result.value === 'number' ? formatValue(result.value, block.format, rc.locale) : display(result.value);
			return h(
				'div',
				{ className: `${P}-calc` },
				h('div', { className: `${P}-calc-label` }, display(block.label)),
				h('div', { className: cx(`${P}-calc-value`, result.error !== undefined && `${P}-calc-empty`), title: result.error === undefined ? undefined : rc.t('calcFailed') }, shown),
				hint === undefined ? null : h('div', { className: `${P}-calc-hint` }, hint)
			);
		}

		/** Buttons that hand the user's choice back to the agent. */
		function ButtonsBlock({ block, rc }) {
			const buttons = asArray(block.buttons).filter((button) => isPlainObject(button));
			return h(
				'div',
				{ className: `${P}-actions` },
				buttons.map((button, index) => {
					const style = asEnum(button.style, ['primary', 'default'], 'default');
					const open = asText(button.open);
					const message = button.message;
					const onClick =
						typeof message === 'string'
							? () => rc.send(interpolate(message, rc.spec, rc.values))
							: open === undefined
								? undefined
								: () => rc.openPath(open);
					return h(
						'button',
						{
							key: index,
							type: 'button',
							className: cx(`${P}-button`, style === 'primary' && `${P}-button-primary`),
							onClick
						},
						display(button.label)
					);
				})
			);
		}

		/** Element type → renderer. The Host's catalog is the authority on the shape. */
		const RENDERERS = {
			section: SectionBlock,
			row: RowBlock,
			text: TextBlock,
			callout: CalloutBlock,
			divider: DividerBlock,
			stat: StatBlock,
			table: TableBlock,
			chart: ChartBlock,
			comparison: ComparisonBlock,
			timeline: TimelineBlock,
			diagram: DiagramBlock,
			tabs: TabsBlock,
			inputs: InputsBlock,
			calc: CalcBlock,
			buttons: ButtonsBlock
		};

		// #endregion elements

		// #region view shell

		/** Fallback for a host that publishes no store hook. */
		const useNoSnapshot = () => undefined;

		/**
		 * Name a call block carries, wherever it sits in the dispatch tree. A block is
		 * `{phase,name,argsRaw}` while it runs and `{kind:'tool-result',call:{...}}`
		 * once it has settled; a PTC sub-call uses these very shapes.
		 * @param block - a call block.
		 * @returns the wire Tool name, or undefined when the block carries none.
		 */
		function callName(block) {
			if (block === undefined || block === null || typeof block !== 'object') return undefined;
			if (!('kind' in block)) return block.name;
			const call = block.call;
			return call === undefined || call === null ? undefined : call.name;
		}

		/** True when this call block, or one of its nested PTC sub-calls, carries the id. */
		function holdsCall(block, callId) {
			if (block === undefined || block === null || typeof block !== 'object') return false;
			if (block.callId === callId) return true;
			const children = block.subCalls;
			return Array.isArray(children) && children.some((child) => holdsCall(child, callId));
		}

		/**
		 * Turn status of the Tool call row carrying this call id. The Chat snapshot
		 * indexes Locations by Turn, not by call, so the search walks the ordered
		 * node list backwards: the addressed call is always near the end.
		 * @param snapshot - Chat snapshot from `useChat`.
		 * @param callId - the row's own call identity.
		 * @returns `'open'`, `'closed'`, or `'unknown'` when the node is not loaded.
		 */
		function callStatus(snapshot, callId) {
			if (snapshot === undefined || snapshot === null || callId === undefined) return 'unknown';
			const nodes = snapshot.nodes;
			const order = snapshot.order;
			if (nodes === undefined || order === undefined) return 'unknown';
			for (let index = order.length - 1; index >= 0; index--) {
				const node = nodes.get(order[index]);
				if (node === undefined || node === null || node.kind !== 'tool-call') continue;
				const root = node.data === undefined || node.data === null ? undefined : node.data.root;
				if (!holdsCall(root, callId)) continue;
				const location = node.location;
				if (location === undefined || location === null || location.turn === undefined) return 'unknown';
				return location.turn.status;
			}
			return 'unknown';
		}

		/** The row's own copy once the Turn has settled: a pointer, not a second view. */
		function SettledNote({ t }) {
			return h(
				'div',
				{ className: cx(P, `${P}-settled`) },
				h('span', { className: `${P}-badge`, 'aria-hidden': 'true' }),
				h('span', { className: `${P}-settled-text` }, t('settledNote'))
			);
		}

		/** Keeps one broken block from taking the whole view down. */
		class BlockBoundary extends React.Component {
			constructor(props) {
				super(props);
				this.state = { failed: false };
			}

			static getDerivedStateFromError() {
				return { failed: true };
			}

			componentDidCatch(error) {
				const hook = typeof window === 'undefined' ? undefined : window.__dshIntelligentUi;
				if (hook !== undefined) hook.lastError = { type: this.props.type, message: error instanceof Error ? error.message : String(error) };
			}

			render() {
				if (this.state.failed)
					return h('div', { className: `${P}-failed` }, this.props.t('blockFailed', { type: this.props.type }));
				return this.props.children;
			}
		}

		/** The whole view for one call: shared state, chrome, and the block list. */
		function ViewCard({ resolved, env }) {
			const spec = resolved.spec;
			const [values, setValues] = React.useState(() => initialValues(spec));
			const [copied, setCopied] = React.useState(false);
			const instance = React.useId === undefined ? 'iui' : React.useId();
			const setValue = React.useCallback((name, value) => setValues((current) => ({ ...current, [name]: value })), []);
			const send = React.useCallback(
				(text) => {
					if (env.inputActions === undefined || text === '') return;
					env.inputActions.setDraft(text);
					env.inputActions.submit();
				},
				[env.inputActions]
			);
			const openPath = React.useCallback(
				(path) => {
					if (env.openFile === undefined) return;
					const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) ? path : `${env.cwd ?? '.'}/${path}`;
					env.openFile(absolute);
				},
				[env.openFile, env.cwd]
			);
			const rc = {
				t: env.t,
				locale: env.locale,
				spec,
				values,
				setValue,
				send,
				openPath,
				instance,
				budget: { left: NODE_BUDGET },
				depth: 0
			};
			const title = asText(spec.title);
			const summary = asText(spec.summary);
			const dropped = asArray(spec.dropped).length;
			const copyRaw = () => {
				const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
				if (clipboard === undefined) return;
				clipboard.writeText(JSON.stringify(spec, null, 2)).then(
					() => setCopied(true),
					() => undefined
				);
			};
			return h(
				'div',
				{ className: `${P}` },
				h(
					'div',
					{ className: `${P}-card` },
					title === undefined && summary === undefined && env.phase !== 'result'
						? null
						: h(
								'div',
								{ className: `${P}-head` },
								h('span', { className: `${P}-badge`, 'aria-hidden': 'true' }),
								h(
									'div',
									{ className: `${P}-head-text` },
									title === undefined ? null : h('div', { className: `${P}-head-title` }, title),
									summary === undefined ? null : h('div', { className: `${P}-head-summary` }, summary)
								),
								env.phase === 'result' ? null : h('span', { className: `${P}-head-note` }, env.t('streaming'))
							),
					h('div', { className: `${P}-body` }, renderBlocks(spec.blocks, rc)),
					dropped === 0 ? null : h('div', { className: `${P}-foot` }, env.t('droppedBlocks', { count: dropped }))
				),
				h(
					'details',
					{ className: `${P}-raw` },
					h('summary', null, env.t('rawSpec')),
					h(
						'div',
						{ className: `${P}-raw-body` },
						h(
							'button',
							{ type: 'button', className: `${P}-button`, onClick: copyRaw, disabled: typeof navigator === 'undefined' },
							copied ? env.t('copied') : env.t('copyJson')
						),
						h('pre', null, JSON.stringify(spec, null, 2))
					)
				)
			);
		}

		/** Placeholder while the call is still being written. */
		function Skeleton({ t, label }) {
			return h(
				'div',
				{ className: `${P}` },
				h(
					'div',
					{ className: `${P}-card` },
					h(
						'div',
						{ className: `${P}-head` },
						h('span', { className: `${P}-badge`, 'aria-hidden': 'true' }),
						h('div', { className: `${P}-head-text` }, h('div', { className: `${P}-head-title` }, label ?? t('preparing')))
					),
					h('div', { className: `${P}-body` }, h('div', { className: `${P}-skeleton` }))
				)
			);
		}

		/** The spec could not be read at all. */
		function Unrenderable({ t, raw }) {
			return h(
				'div',
				{ className: `${P}` },
				h(
					'div',
					{ className: `${P}-card` },
					h(
						'div',
						{ className: `${P}-head` },
						h('span', { className: cx(`${P}-badge`, `${P}-badge-error`), 'aria-hidden': 'true' }),
						h('div', { className: `${P}-head-text` }, h('div', { className: `${P}-head-title` }, t('unreadable')))
					),
					raw === '' ? null : h('div', { className: `${P}-body` }, h('pre', { className: `${P}-raw-text` }, raw))
				)
			);
		}

		/**
		 * One resolved view. While its Turn runs this is the call's own row, which
		 * streams the view as the arguments arrive; once the Turn settles the row
		 * yields to the Turn tail's copy and shows a pointer instead.
		 */
		function RenderUiView(props) {
			const { block, phase, t, cwd, openFile, inputActions } = props;
			const readChat = props.useChat ?? useNoSnapshot;
			const status = readChat((state) => callStatus(state, props.callId));
			const settledTurn = status === 'closed';
			const resolved = React.useMemo(() => specFromBlock(phase, block), [phase, block]);
			const locale = props.locale;
			const env = React.useMemo(
				() => ({ t, locale, cwd, openFile, inputActions, phase }),
				[t, locale, cwd, openFile, inputActions, phase]
			);
			const hook = typeof window === 'undefined' ? undefined : window.__dshIntelligentUi;
			if (hook !== undefined) {
				hook.lastRender = {
					from: props.from ?? 'toolview',
					state: resolved.state,
					source: resolved.source,
					phase,
					blocks: resolved.spec === undefined ? 0 : resolved.spec.blocks.length,
					title: resolved.spec === undefined ? undefined : resolved.spec.title,
					types: resolved.spec === undefined ? [] : [...new Set(resolved.spec.blocks.map((entry) => entry.type))],
					interactive: inputActions !== undefined,
					turnStatus: status,
					shown: settledTurn ? 'note' : resolved.state === 'ready' ? 'card' : resolved.state
				};
			}
			/*
			 * The settled copy lives in the Turn tail, outside the Tool group. Keeping
			 * the card here as well would show one view twice whenever that group is
			 * open (verbose work details, or a manual expand).
			 */
			if (settledTurn) return h(SettledNote, { t });
			if (resolved.state === 'preparing') return h(Skeleton, { t });
			if (resolved.state === 'streaming') return h(Skeleton, { t, label: t('streaming') });
			if (resolved.state === 'failed') return h(Unrenderable, { t, raw: resolved.raw });
			return h(ViewCard, { resolved, env });
		}

		// #endregion view shell

		// #region turn tail

		/** Shared empty result, so `useMemo` never hands React a fresh array. */
		const NO_VIEWS = [];

		/** Subscribe to the whole Chat snapshot; the tail derives from it in a memo. */
		const selectSnapshot = (state) => state;

		/**
		 * The tail subscribes to the Chat snapshot, so every publish anywhere in the
		 * Session re-renders it. Its own card is memoized: the call block and the
		 * Environment it renders are reference-stable, so an unrelated publish must
		 * not redraw a settled view.
		 */
		const SettledView = React.memo(RenderUiView);

		/**
		 * Append every `render_ui` call in this dispatch subtree. A PTC `run_code`
		 * block owns its nested calls, so the walk descends into `subCalls` — those
		 * nodes are not in the Location index on their own.
		 * @param block - call block to inspect.
		 * @param out - accumulator.
		 * @param fallbackKey - React key when the block carries no call id.
		 */
		function collectViews(block, out, fallbackKey) {
			if (block === undefined || block === null || typeof block !== 'object') return;
			if (callName(block) === TOOL_NAME) {
				out.push({
					key: typeof block.callId === 'string' ? block.callId : fallbackKey,
					phase: 'kind' in block ? 'result' : block.phase === 'preparing' ? 'preparing' : 'start',
					block
				});
				return;
			}
			const children = block.subCalls;
			if (Array.isArray(children)) for (const child of children) collectViews(child, out, fallbackKey);
		}

		/**
		 * The `render_ui` calls of one Turn, read from the Chat snapshot. The Location
		 * index is keyed by Turn number, so a `TurnLocation` is unwrapped.
		 * @param snapshot - Chat snapshot from `useChat`.
		 * @param turn - the Turn (or its number) this tail belongs to.
		 * @returns the calls in transcript order, or the shared empty list.
		 */
		function turnViews(snapshot, turn) {
			if (snapshot === undefined || snapshot === null || turn === undefined || turn === null) return NO_VIEWS;
			const locations = snapshot.locations;
			const nodes = snapshot.nodes;
			if (locations === undefined || nodes === undefined || typeof locations.getTurn !== 'function') return NO_VIEWS;
			const number = typeof turn === 'object' ? turn.turn : turn;
			if (number === undefined || number === null) return NO_VIEWS;
			const found = [];
			for (const key of locations.getTurn(number)) {
				const node = nodes.get(key);
				if (node === undefined || node === null || node.kind !== 'tool-call' || node.visibility === 'hidden') continue;
				const root = node.data === undefined || node.data === null ? undefined : node.data.root;
				if (root === undefined || root === null || typeof root !== 'object') continue;
				collectViews(root, found, key);
			}
			return found.length === 0 ? NO_VIEWS : found;
		}

		/**
		 * The `conversation.chat.turnTail` entry. The call row lives inside the
		 * collapsible Tool group, which folds away once the Turn closes, so the
		 * settled view is contributed again beside the answer. While the Turn is
		 * still open the call row owns the only copy, and this entry renders
		 * nothing: one live view, never two.
		 */
		function ViewTail(props) {
			const { turn, openFile, inputActions, t, locale } = props;
			const sessionId = props.sessionId;
			const useChat = props.useChat ?? useNoSnapshot;
			const useSessions = props.useSessions ?? useNoSnapshot;
			const snapshot = useChat(selectSnapshot);
			const selectCwd = React.useCallback(
				(state) => (state === undefined || state === null || sessionId === undefined ? undefined : state.byId?.[sessionId]?.cwd),
				[sessionId]
			);
			const cwd = useSessions(selectCwd);
			const closed = turn !== undefined && turn !== null && turn.status !== 'open';
			const views = React.useMemo(() => (closed ? turnViews(snapshot, turn) : NO_VIEWS), [closed, snapshot, turn]);
			const hook = typeof window === 'undefined' ? undefined : window.__dshIntelligentUi;
			if (hook !== undefined) hook.lastTail = { turn: turn === undefined || turn === null ? null : turn.turn, closed, views: views.length };
			if (views.length === 0) return null;
			return h(
				'div',
				{ className: `${P}-tail`, 'data-iui-tail': turn === undefined || turn === null ? '' : String(turn.turn) },
				views.map((view) =>
					h(SettledView, {
						key: view.key,
						block: view.block,
						phase: view.phase,
						t,
						locale,
						cwd,
						openFile,
						inputActions,
						from: 'tail'
					})
				)
			);
		}

		// #endregion turn tail

		// #region styles

		/**
		 * Plugin stylesheet. Colours come from theme tokens only, so light and dark
		 * follow the app; the fallbacks cover tokens a theme may not define.
		 */
		const STYLES = `
.${P} {
	/* Series colours stay chromatic in both themes; the brand token is near-black in
	   light mode and near-white in dark, which reads as a wireframe in a chart. */
	--${P}-series-1: var(--dsw-alias-state-business-primary, #4176e6);
	--${P}-series-2: var(--dsw-alias-state-success-primary, #14a76c);
	--${P}-series-3: var(--dsw-alias-state-warn-primary, #e08a00);
	--${P}-series-4: var(--dsw-alias-state-error-primary, #e5484d);
	--${P}-series-5: var(--dsw-alias-state-idle-primary, #8a8f98);
	display: flex;
	flex-direction: column;
	gap: 8px;
	font-family: var(--dsw-font-family, inherit);
	font-size: var(--dsw-font-xs-13, 13px);
	line-height: 1.6;
	color: var(--dsw-alias-label-primary, inherit);
}
.${P} *, .${P} *::before, .${P} *::after { box-sizing: border-box; }
.${P}-card {
	border: .5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25));
	border-radius: var(--dsw-radius-lg, 12px);
	background: var(--dsw-alias-bg-layer-1, rgba(128,128,128,.06));
	overflow: hidden;
}
.${P}-tail { display: flex; flex-direction: column; gap: 12px; margin-top: 2px; }
.${P}-settled { flex-direction: row; align-items: center; gap: 8px; color: var(--dsw-alias-label-secondary, inherit); }
.${P}-settled-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${P}-head {
	display: flex; align-items: center; gap: 8px;
	padding: 9px 14px;
	border-bottom: .5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25));
}
.${P}-badge { width: 6px; height: 6px; border-radius: 50%; flex: none; background: var(--dsw-alias-brand-primary, #4d6bfe); }
.${P}-badge-error { background: var(--dsw-alias-state-error-primary, #e5484d); }
.${P}-head-text { flex: 1 1 auto; min-width: 0; }
.${P}-head-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${P}-head-summary { color: var(--dsw-alias-label-secondary, inherit); font-size: var(--dsw-font-xxs-12, 12px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${P}-head-note { flex: none; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit)); font-size: var(--dsw-font-xxs-12, 12px); }
.${P}-body { display: flex; flex-direction: column; gap: 14px; padding: 14px; }
.${P}-foot { padding: 0 14px 10px; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit)); font-size: var(--dsw-font-xxs-12, 12px); }
.${P}-block-title { font-weight: 600; margin-bottom: 6px; }
.${P}-block-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.${P}-axis-caption { flex: none; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit)); font-size: 11px; }

.${P}-section { display: flex; flex-direction: column; gap: 6px; }
.${P}-section-title { margin: 0; font-size: 1em; font-weight: 600; }
.${P}-section-subtitle { margin: 0; color: var(--dsw-alias-label-secondary, inherit); font-size: var(--dsw-font-xxs-12, 12px); }
.${P}-section-body { display: flex; flex-direction: column; gap: 12px; }

.${P}-row { display: flex; flex-wrap: wrap; gap: 12px; }
.${P}-row > * { flex: 1 1 120px; min-width: 0; }

.${P}-text { margin: 0; }
.${P}-text-lead { font-size: 1.08em; }
.${P}-text-caption { color: var(--dsw-alias-label-secondary, inherit); font-size: var(--dsw-font-xxs-12, 12px); }

.${P}-callout {
	padding: 9px 12px;
	border-radius: var(--dsw-radius-md, 8px);
	border-left: 2px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4));
	background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1));
}
.${P}-callout-info { border-left-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.${P}-callout-success { border-left-color: var(--dsw-alias-state-success-primary, #14a76c); }
.${P}-callout-warn { border-left-color: var(--dsw-alias-state-warn-primary, #e08a00); }
.${P}-callout-error { border-left-color: var(--dsw-alias-state-error-primary, #e5484d); }
.${P}-callout-title { font-weight: 600; margin-bottom: 2px; }
.${P}-callout-text { color: var(--dsw-alias-label-secondary, inherit); }
.${P}-callout-info .${P}-callout-text, .${P}-callout-success .${P}-callout-text,
.${P}-callout-warn .${P}-callout-text, .${P}-callout-error .${P}-callout-text { color: var(--dsw-alias-label-primary, inherit); }

.${P}-divider { height: 0; margin: 2px 0; border: 0; border-top: .5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); }

.${P}-stat { display: flex; flex-direction: column; gap: 2px; }
.${P}-stat-label { color: var(--dsw-alias-label-secondary, inherit); font-size: var(--dsw-font-xxs-12, 12px); }
.${P}-stat-value { font-size: 1.5em; font-weight: 600; line-height: 1.25; }
.${P}-stat-delta { color: var(--dsw-alias-state-success-primary, #14a76c); font-size: var(--dsw-font-xxs-12, 12px); }
.${P}-stat-hint { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit)); font-size: var(--dsw-font-xxs-12, 12px); }

.${P}-table-wrap { overflow-x: auto; }
.${P}-table { width: 100%; border-collapse: collapse; }
.${P}-table th {
	padding: 0 8px 6px; font-size: var(--dsw-font-xxs-12, 12px); font-weight: 600;
	color: var(--dsw-alias-label-secondary, inherit);
	border-bottom: .5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25));
	white-space: nowrap;
}
.${P}-table td { padding: 6px 8px; border-bottom: .5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); vertical-align: top; }
.${P}-table tr:last-child td { border-bottom: 0; }
.${P}-th-button { display: inline-flex; align-items: center; gap: 4px; padding: 0; border: 0; background: none; font: inherit; color: inherit; cursor: pointer; }
.${P}-sort-mark { font-size: .75em; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit)); }

.${P}-chart { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.${P}-svg { display: block; width: 100%; height: auto; overflow: visible; }
.${P}-grid { stroke: var(--dsw-alias-border-l1, rgba(128,128,128,.25)); stroke-width: 1; }
.${P}-axis-tick, .${P}-edge-label { fill: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit)); font-size: 9px; }
.${P}-bar { transition: opacity .12s ease; }
.${P}-slice { stroke: var(--dsw-alias-bg-layer-1, transparent); stroke-width: 1; }
.${P}-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; margin: 0; padding: 0; list-style: none; }
.${P}-legend-item { display: inline-flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary, inherit); font-size: var(--dsw-font-xxs-12, 12px); }
.${P}-swatch { width: 8px; height: 8px; border-radius: 2px; flex: none; }

.${P}-comparison { display: flex; flex-direction: column; min-width: 0; }
.${P}-comparison-grid { display: grid; gap: 0; border: .5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); border-radius: var(--dsw-radius-md, 8px); overflow: hidden; }
.${P}-comparison-grid > div { padding: 7px 10px; border-bottom: .5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); min-width: 0; }
.${P}-comparison-corner { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1)); }
.${P}-comparison-head { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1)); font-weight: 600; display: flex; flex-direction: column; }
.${P}-comparison-hint { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit)); font-size: var(--dsw-font-xxs-12, 12px); font-weight: 400; }
.${P}-comparison-attribute { color: var(--dsw-alias-label-secondary, inherit); font-size: var(--dsw-font-xxs-12, 12px); }

.${P}-timeline-wrap { display: flex; flex-direction: column; min-width: 0; }
.${P}-timeline { margin: 0; padding: 0 0 0 6px; list-style: none; display: flex; flex-direction: column; gap: 10px; }
.${P}-timeline-item { position: relative; display: flex; gap: 12px; }
.${P}-timeline-item:not(:last-child)::before {
	content: ''; position: absolute; left: 3px; top: 14px; bottom: -10px;
	border-left: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4));
}
.${P}-timeline-dot {
	position: relative; z-index: 1; flex: none; margin-top: 5px;
	width: 7px; height: 7px; border-radius: 50%;
	background: var(--dsw-alias-brand-primary, #4d6bfe);
}
.${P}-timeline-body { min-width: 0; }
.${P}-timeline-head { display: flex; align-items: baseline; gap: 8px; }
.${P}-timeline-label { font-weight: 600; }
.${P}-timeline-at { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit)); font-size: var(--dsw-font-xxs-12, 12px); }
.${P}-timeline-detail { color: var(--dsw-alias-label-secondary, inherit); }

.${P}-diagram { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.${P}-edge { stroke: var(--dsw-alias-border-l2, rgba(128,128,128,.4)); stroke-width: 1.2; }
.${P}-node { cursor: pointer; outline: none; }
.${P}-node-box { fill: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1)); stroke: var(--dsw-alias-border-l2, rgba(128,128,128,.4)); stroke-width: 1; }
.${P}-node-label { fill: var(--dsw-alias-label-primary, inherit); font-size: 10px; }
.${P}-node:hover .${P}-node-box { stroke: var(--dsw-alias-brand-primary, #4d6bfe); }
.${P}-node:focus-visible .${P}-node-box, .${P}-node-active .${P}-node-box { stroke: var(--dsw-alias-brand-primary, #4d6bfe); stroke-width: 1.6; }
.${P}-node-detail {
	padding: 7px 10px; border-radius: var(--dsw-radius-md, 8px);
	background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1));
	color: var(--dsw-alias-label-secondary, inherit);
	display: flex; gap: 8px; align-items: baseline;
}
.${P}-node-detail strong { color: var(--dsw-alias-label-primary, inherit); }

.${P}-tabs { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.${P}-tablist { display: flex; gap: 4px; border-bottom: .5px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); }
.${P}-tab {
	appearance: none; border: 0; background: none; font: inherit; cursor: pointer;
	padding: 5px 10px; margin-bottom: -1px; color: var(--dsw-alias-label-secondary, inherit);
	border-bottom: 2px solid transparent; border-radius: var(--dsw-radius-xs, 4px) var(--dsw-radius-xs, 4px) 0 0;
}
.${P}-tab:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12)); }
.${P}-tab-active { color: var(--dsw-alias-label-primary, inherit); border-bottom-color: var(--dsw-alias-brand-primary, #4d6bfe); font-weight: 600; }
.${P}-tabpanel { display: flex; flex-direction: column; gap: 12px; }

.${P}-inputs { display: flex; flex-direction: column; gap: 10px; }
.${P}-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.${P}-field-inline { flex-direction: row; align-items: center; gap: 8px; }
.${P}-field-label { color: var(--dsw-alias-label-secondary, inherit); font-size: var(--dsw-font-xxs-12, 12px); }
.${P}-control {
	width: 100%; min-width: 0; padding: 5px 8px; font: inherit;
	color: var(--dsw-alias-label-primary, inherit);
	background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1));
	border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4));
	border-radius: var(--dsw-radius-md, 8px);
}
.${P}-field-inline .${P}-control { width: auto; }
.${P}-control:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.${P}-field-hint { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit)); font-size: var(--dsw-font-xxs-12, 12px); }
.${P}-range { display: flex; align-items: center; gap: 10px; }
.${P}-range .${P}-control { flex: 1 1 auto; padding: 0; background: none; border: 0; accent-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.${P}-range-value { flex: none; min-width: 2.5em; text-align: right; font-variant-numeric: tabular-nums; }

.${P}-calc {
	display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap;
	padding: 9px 12px; border-radius: var(--dsw-radius-md, 8px);
	background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1));
}
.${P}-calc-label { color: var(--dsw-alias-label-secondary, inherit); }
.${P}-calc-value { font-size: 1.35em; font-weight: 600; font-variant-numeric: tabular-nums; }
.${P}-calc-empty { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit)); font-weight: 400; }
.${P}-calc-hint { color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit)); font-size: var(--dsw-font-xxs-12, 12px); }

.${P}-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.${P}-button {
	appearance: none; font: inherit; cursor: pointer;
	padding: 5px 12px;
	color: var(--dsw-alias-label-primary, inherit);
	background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1));
	border: .5px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4));
	border-radius: var(--dsw-radius-md, 8px);
	transition: background .12s ease;
}
.${P}-button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18)); }
.${P}-button:disabled { opacity: .5; cursor: default; }
.${P}-button-primary {
	color: var(--dsw-alias-label-primary-foreground, #fff);
	background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary, #4d6bfe));
	border-color: transparent;
}
.${P}-button-primary:hover { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary, #4d6bfe)); }

.${P}-raw { font-size: var(--dsw-font-xxs-12, 12px); color: var(--dsw-alias-label-secondary, inherit); }
.${P}-raw > summary { cursor: pointer; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit)); }
.${P}-raw-body { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; padding-top: 8px; }
.${P}-raw-body pre, .${P}-raw-text {
	width: 100%; max-height: 260px; overflow: auto; margin: 0; padding: 10px;
	font-family: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
	font-size: var(--dsw-font-xxs-12, 12px); line-height: 1.5;
	background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1));
	border-radius: var(--dsw-radius-md, 8px);
	white-space: pre-wrap; word-break: break-word;
}
.${P}-skeleton {
	height: 92px; border-radius: var(--dsw-radius-md, 8px);
	background: linear-gradient(90deg, var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)) 0%, var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.16)) 50%, var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)) 100%);
	background-size: 200% 100%;
	animation: ${P}-pulse 1.5s ease-in-out infinite;
}
@keyframes ${P}-pulse { from { background-position: 100% 0; } to { background-position: -100% 0; } }
@media (prefers-reduced-motion: reduce) { .${P}-skeleton { animation: none; } }
.${P}-failed, .${P}-omitted {
	padding: 7px 10px; border-radius: var(--dsw-radius-md, 8px);
	background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1));
	color: var(--dsw-alias-label-secondary, inherit);
	font-size: var(--dsw-font-xxs-12, 12px);
}
.${P}-failed { color: var(--dsw-alias-state-error-primary, #e5484d); }
`;

		// #endregion styles

		// #region locale

		/** Dictionaries for the few strings this view needs. `t` takes `{name}` params. */
		const JA = {
			preparing: '表示を作成しています…',
			streaming: '描画中',
			unreadable: 'この表示を読み取れませんでした',
			rawSpec: '仕様 (JSON)',
			copyJson: 'JSON をコピー',
			copied: 'コピーしました',
			droppedBlocks: '表示できないブロックが {count} 件ありました',
			omittedBlocks: '残り {count} 件のブロックを省略しました',
			blockFailed: '「{type}」を表示できませんでした',
			diagramHint: 'ノードを選ぶと詳細を表示します',
			calcFailed: '式を評価できません',
			settledNote: 'ビューは回答の下に表示しています'
		};
		const EN = {
			preparing: 'Building the view…',
			streaming: 'Drawing',
			unreadable: 'This view could not be read',
			rawSpec: 'Spec (JSON)',
			copyJson: 'Copy JSON',
			copied: 'Copied',
			droppedBlocks: '{count} block(s) could not be shown',
			omittedBlocks: '{count} more block(s) omitted',
			blockFailed: 'Could not show “{type}”',
			diagramHint: 'Select a node for details',
			calcFailed: 'The expression cannot be evaluated',
			settledNote: 'The view is shown below this answer'
		};
		const ZH = {
			preparing: '正在生成视图…',
			streaming: '绘制中',
			unreadable: '无法读取此视图',
			rawSpec: '规格 (JSON)',
			copyJson: '复制 JSON',
			copied: '已复制',
			droppedBlocks: '有 {count} 个区块无法显示',
			omittedBlocks: '省略了其余 {count} 个区块',
			blockFailed: '无法显示“{type}”',
			diagramHint: '选择节点以查看详情',
			calcFailed: '无法计算该表达式',
			settledNote: '视图显示在回答下方'
		};

		// #endregion locale

		// #region plugin

		/** Client services this plugin reads. */
		const inject = ['slots', 'locale'];

		/** Install the stylesheet once; removed again when the plugin unloads. */
		function installStyles() {
			const tag = document.createElement('style');
			tag.dataset.pluginCss = 'dsh-intelligent-ui';
			tag.textContent = STYLES;
			document.head.append(tag);
			return () => tag.remove();
		}

		/**
		 * Dev hook: the same code the view runs, reachable from the browser console
		 * and from the `vm` smoke test. Removed when the plugin unloads.
		 */
		function installDebugHook() {
			const hook = {
				version: VERSION,
				toolName: TOOL_NAME,
				types: TYPES,
				looseJson,
				sanitizeSpec,
				specFromBlock,
				compileExpr,
				runExpr,
				formatValue,
				niceTicks,
				diagramEdge,
				callStatus,
				turnViews,
				interpolate,
				initialValues,
				lastRender: null,
				lastTail: null,
				lastError: null
			};
			window.__dshIntelligentUi = hook;
			return () => {
				if (window.__dshIntelligentUi === hook) delete window.__dshIntelligentUi;
			};
		}

		/** Read the active locale id, so numbers group the way the app does. */
		function activeLocale(ctx) {
			try {
				const face = ctx.locale.getLocale === undefined ? undefined : ctx.locale.getLocale();
				return typeof face?.active === 'string' ? face.active : undefined;
			} catch {
				return undefined;
			}
		}

		/**
		 * Register the `render_ui` toolview and the strings it needs.
		 * @param ctx - the client plugin context.
		 */
		function apply(ctx) {
			const bound = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { ja: JA, en: EN, zh: ZH }), 'dsh-intelligent-ui: dictionaries');
			ctx.effect(installStyles, 'dsh-intelligent-ui: styles');
			ctx.effect(installDebugHook, 'dsh-intelligent-ui: verification hook');

			/**
			 * The row for a `render_ui` call is the view itself. The slot is keyed by
			 * the wire tool name, so the key must stay identical to it.
			 */
			function Row(props) {
				const t = props.t ?? bound;
				return h(RenderUiView, { ...props, t, locale: props.locale ?? activeLocale(ctx) });
			}

			/** The Turn tail entry: same view, contributed beside the answer. */
			function Tail(props) {
				const t = props.t ?? bound;
				return h(ViewTail, { ...props, t, locale: props.locale ?? activeLocale(ctx) });
			}

			/**
			 * The row is the live view while the call runs. The Turn tail keeps the
			 * settled view visible after the Tool group folds: registering only the
			 * row would bury it behind the group's disclosure.
			 */
			ctx.slots.inject('tool.call.toolview', () =>
				ctx.slots.register({ name: 'tool.call.toolview', key: TOOL_NAME, locale: NS }, Row)
			);
			/** Sorted before the shipped tails (default order 0), so the view sits under the prose. */
			ctx.slots.inject('conversation.chat.turnTail', () =>
				ctx.slots.register({ name: 'conversation.chat.turnTail', id: PLUGIN_ID, order: -10, locale: NS }, Tail)
			);
		}

		// #endregion plugin

		return { inject, apply };
	}
});

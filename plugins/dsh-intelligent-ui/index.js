/**
 * dsh-intelligent-ui — Host half.
 *
 * Registers `render_ui`: the model composes one declarative view spec, this
 * half validates it into a normalized spec and publishes that spec on the Tool
 * result through `output.presentationMeta`, and the browser draws it inside the
 * call's own row (the client registers the `tool.call.toolview` entry).
 *
 * The element catalog ships as a runtime skill instead of riding the tool
 * description, so it costs nothing until the model actually needs it; when the
 * profile has no skill registry, the same constant becomes the description.
 *
 * No Harness package is imported on purpose: a local plugin does not resolve
 * `@deepseek-ai/*` from the profile, so `defineTool` (the author DSL) and
 * schemastery `Config` are both unavailable. The tool is therefore a plain
 * ToolDefinition object with a raw JSON Schema, `execute` is the only argument
 * validator, and config is validated here by hand.
 */

import { readFileSync } from 'node:fs';

/** Package identity, reused by diagnostics and the client's dev hook. */
const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
/** Version reported by `window.__dshIntelligentUi`. */
export const VERSION = manifest.version;

/** Wire name of the tool. The client's toolview key must match it statically. */
export const TOOL_NAME = 'render_ui';

/** Name of the runtime skill that carries the element catalog. */
export const SKILL_NAME = 'intelligent-ui';

/** Services this plugin needs. */
export const inject = ['tools', 'skills', 'systemPrompt'];

/**
 * The element catalog, loaded from `catalog.md` so it stays readable Markdown
 * and single-sourced between the skill body and the fallback tool description.
 */
export const CATALOG = readFileSync(new URL('./catalog.md', import.meta.url), 'utf8').trim();

/** Element types, in catalog order. The client keeps the matching renderer registry. */
export const TYPES = [
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

/** Bounds that keep one view renderable and one spec affordable to write. */
const BOUNDS = {
	maxDepth: 6,
	maxColumns: 8,
	maxRows: 100,
	maxSeriesPoints: 200,
	maxItems: 40,
	maxEdges: 80,
	maxButtons: 4,
	maxFields: 12,
	maxTabs: 4,
	maxComparisonColumns: 4
};

/** Non-default deployment postures. `auto` needs no prompt section at all. */
const POSTURE_SECTIONS = {
	encourage:
		'Prefer an interactive or visual answer to prose whenever the user compares options, reads data, follows a sequence, or adjusts numbers: call render_ui and keep the prose to the conclusion.',
	off: 'Use render_ui only when the user explicitly asks for a diagram, chart, table, calculator, or interactive view.'
};

// #region validation

/** Scalar and collection validator constructors for the spec below. */
const S = {
	str: (o = {}) => ({ kind: 'string', ...o }),
	num: (o = {}) => ({ kind: 'number', ...o }),
	bool: (o = {}) => ({ kind: 'boolean', ...o }),
	scalar: (o = {}) => ({ kind: 'scalar', ...o }),
	enum: (values, o = {}) => ({ kind: 'enum', values, ...o }),
	list: (item, o = {}) => ({ kind: 'array', item, ...o }),
	obj: (props, o = {}) => ({ kind: 'object', props: props ?? {}, ...o }),
	map: (value, o = {}) => ({ kind: 'map', value, ...o }),
	elements: (o = {}) => ({ kind: 'elements', ...o })
};

/** Human-readable type of a JSON value, for error messages. */
function typeName(value) {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'an array';
	switch (typeof value) {
		case 'object':
			return 'an object';
		case 'string':
			return 'a string';
		case 'number':
			return 'a number';
		case 'boolean':
			return 'a boolean';
		default:
			return `a ${typeof value}`;
	}
}

/** Type plus the offending scalar, so the model can see what it wrote. */
function describeValue(value) {
	const name = typeName(value);
	if (value === null || typeof value === 'object') return name;
	return `${name} (${JSON.stringify(value)})`;
}

/** Whether a value may appear in a table cell, comparison cell, or option value. */
function isScalar(value) {
	if (typeof value === 'string' || typeof value === 'boolean') return true;
	return typeof value === 'number' && Number.isFinite(value);
}

/** Whether a value is a plain JSON object (not null, not an array). */
function isPlainObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Fail with a message the model can act on. */
function fail(message) {
	throw new Error(`${TOOL_NAME}: ${message}`);
}

/**
 * Optional cross-field rules that a per-key schema cannot express (uniqueness,
 * index alignment, conditional requirements). Each throws a model-fixable error.
 */
const FINISH = {
	table(view, path) {
		const keys = view.columns.map((column) => column.key);
		const duplicate = keys.find((key, index) => keys.indexOf(key) !== index);
		if (duplicate !== undefined) fail(`${path}.columns uses the key "${duplicate}" more than once`);
		if (view.initialSort !== undefined && !keys.includes(view.initialSort.key))
			fail(`${path}.initialSort.key "${view.initialSort.key}" is not one of the column keys: ${keys.join(', ')}`);
		view.rows.forEach((row, index) => {
			for (const key of Object.keys(row))
				if (!keys.includes(key))
					fail(`${path}.rows[${index}] has the key "${key}", which is not a column; column keys are: ${keys.join(', ')}`);
		});
	},
	chart(view, path) {
		const width = view.categories.length;
		view.series.forEach((series, index) => {
			if (series.data.length !== width)
				fail(`${path}.series[${index}].data has ${series.data.length} values but categories has ${width}; give every series one value per category`);
		});
		if (view.kind === 'pie' && view.series.length > 1)
			fail(`${path} is a pie chart with ${view.series.length} series; a pie chart takes exactly one`);
	},
	comparison(view, path) {
		const width = view.columns.length;
		view.rows.forEach((row, index) => {
			if (row.values.length !== width)
				fail(`${path}.rows[${index}] has ${row.values.length} values but there are ${width} columns; give every row one value per column`);
		});
	},
	diagram(view, path) {
		const ids = view.nodes.map((node) => node.id);
		const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
		if (duplicate !== undefined) fail(`${path}.nodes uses the id "${duplicate}" more than once`);
		view.edges.forEach((edge, index) => {
			for (const end of ['from', 'to'])
				if (!ids.includes(edge[end]))
					fail(`${path}.edges[${index}].${end} is "${edge[end]}", which is not a node id; node ids are: ${ids.join(', ')}`);
		});
	},
	inputs(view, path) {
		const names = view.fields.map((field) => field.name);
		const duplicate = names.find((name, index) => names.indexOf(name) !== index);
		if (duplicate !== undefined) fail(`${path}.fields uses the name "${duplicate}" more than once`);
		view.fields.forEach((field, index) => {
			const at = `${path}.fields[${index}]`;
			if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field.name))
				fail(`${at}.name "${field.name}" is not an identifier; use letters, digits, and underscores, starting with a letter or underscore`);
			if (field.kind === 'select' && field.options === undefined)
				fail(`${at} is a select field without options; add options: [{ value, label }]`);
			if (field.kind !== 'select' && field.options !== undefined) fail(`${at} has options but its kind is "${field.kind}"`);
			if (field.kind === 'range' && (field.min === undefined || field.max === undefined))
				fail(`${at} is a range field; give it both min and max`);
			if (field.min !== undefined && field.max !== undefined && field.min >= field.max)
				fail(`${at}.min (${field.min}) must be less than max (${field.max})`);
			if (field.value !== undefined) {
				if (field.kind === 'checkbox' && typeof field.value !== 'boolean')
					fail(`${at}.value must be a boolean for a checkbox, got ${describeValue(field.value)}`);
				if ((field.kind === 'number' || field.kind === 'range') && typeof field.value !== 'number')
					fail(`${at}.value must be a number for a ${field.kind} field, got ${describeValue(field.value)}`);
				if ((field.kind === 'text' || field.kind === 'textarea' || field.kind === 'select') && typeof field.value !== 'string')
					fail(`${at}.value must be a string for a ${field.kind} field, got ${describeValue(field.value)}`);
			}
		});
	},
	calc(view, path) {
		if (view.expr.trim() === '') fail(`${path}.expr must not be empty`);
	},
	buttons(view, path) {
		view.buttons.forEach((button, index) => {
			const has = (key) => button[key] !== undefined;
			if (has('message') === has('open'))
				fail(`${path}.buttons[${index}] ("${button.label}") needs exactly one of message or open`);
		});
	}
};

/** The element schema: one entry per type, mirroring the catalog. */
const ELEMENTS = {
	section: { props: { title: S.str(), subtitle: S.str(), blocks: S.elements({ min: 1 }) } },
	row: { props: { blocks: S.elements({ min: 2 }) } },
	text: { props: { text: S.str({ required: true }), style: S.enum(['body', 'lead', 'caption']) } },
	callout: {
		props: {
			tone: S.enum(['info', 'success', 'warn', 'error'], { required: true }),
			title: S.str(),
			text: S.str({ required: true })
		}
	},
	divider: { props: {} },
	stat: {
		props: {
			label: S.str({ required: true }),
			value: S.scalar({ required: true }),
			delta: S.str(),
			hint: S.str()
		}
	},
	table: {
		props: {
			title: S.str(),
			columns: S.list(
				S.obj(
					{
						key: S.str({ required: true }),
						label: S.str({ required: true }),
						align: S.enum(['left', 'right', 'center']),
						format: S.enum(['text', 'number', 'percent'])
					},
					{ describe: 'column' }
				),
				{ required: true, min: 1, max: BOUNDS.maxColumns }
			),
			rows: S.list(S.map(S.scalar()), { required: true, min: 1, max: BOUNDS.maxRows }),
			sortable: S.bool(),
			initialSort: S.obj(
				{ key: S.str({ required: true }), dir: S.enum(['asc', 'desc'], { required: true }) },
				{ describe: 'initialSort' }
			)
		},
		finish: FINISH.table
	},
	chart: {
		props: {
			kind: S.enum(['bar', 'line', 'pie'], { required: true }),
			title: S.str(),
			yLabel: S.str(),
			categories: S.list(S.str(), { required: true, min: 1, max: BOUNDS.maxSeriesPoints }),
			series: S.list(
				S.obj(
					{
						label: S.str({ required: true }),
						data: S.list(S.num(), { required: true, min: 1, max: BOUNDS.maxSeriesPoints }),
						color: S.str()
					},
					{ describe: 'series' }
				),
				{ required: true, min: 1, max: 4 }
			),
			stacked: S.bool()
		},
		finish: FINISH.chart
	},
	comparison: {
		props: {
			title: S.str(),
			columns: S.list(
				S.obj({ label: S.str({ required: true }), hint: S.str() }, { describe: 'comparison column' }),
				{ required: true, min: 2, max: BOUNDS.maxComparisonColumns }
			),
			rows: S.list(
				S.obj(
					{ attribute: S.str({ required: true }), values: S.list(S.scalar(), { required: true, min: 1 }) },
					{ describe: 'comparison row' }
				),
				{ required: true, min: 1, max: BOUNDS.maxItems }
			)
		},
		finish: FINISH.comparison
	},
	timeline: {
		props: {
			title: S.str(),
			items: S.list(
				S.obj({ label: S.str({ required: true }), detail: S.str(), at: S.str() }, { describe: 'timeline item' }),
				{ required: true, min: 1, max: BOUNDS.maxItems }
			)
		}
	},
	diagram: {
		props: {
			title: S.str(),
			layout: S.enum(['flow', 'tree', 'cycle']),
			nodes: S.list(
				S.obj(
					{
						id: S.str({ required: true }),
						label: S.str({ required: true }),
						detail: S.str(),
						group: S.str()
					},
					{ describe: 'diagram node' }
				),
				{ required: true, min: 1, max: BOUNDS.maxItems }
			),
			edges: S.list(
				S.obj({ from: S.str({ required: true }), to: S.str({ required: true }), label: S.str() }, { describe: 'diagram edge' }),
				{ max: BOUNDS.maxEdges }
			)
		},
		finish: FINISH.diagram
	},
	tabs: {
		props: {
			tabs: S.list(
				S.obj({ label: S.str({ required: true }), blocks: S.elements({ required: true, min: 1 }) }, { describe: 'tab' }),
				{ required: true, min: 2, max: BOUNDS.maxTabs }
			)
		}
	},
	inputs: {
		props: {
			title: S.str(),
			fields: S.list(
				S.obj(
					{
						name: S.str({ required: true }),
						label: S.str({ required: true }),
						kind: S.enum(['text', 'textarea', 'number', 'range', 'select', 'checkbox'], { required: true }),
						value: S.scalar(),
						min: S.num(),
						max: S.num(),
						step: S.num(),
						options: S.list(S.obj({ value: S.scalar({ required: true }), label: S.str({ required: true }) }, { describe: 'option' }), {
							min: 1
						}),
						placeholder: S.str(),
						hint: S.str()
					},
					{ describe: 'input field' }
				),
				{ required: true, min: 1, max: BOUNDS.maxFields }
			),
			submit: S.obj({ label: S.str({ required: true }), message: S.str({ required: true }) }, { describe: 'submit' })
		},
		finish: FINISH.inputs
	},
	calc: {
		props: {
			label: S.str({ required: true }),
			expr: S.str({ required: true }),
			format: S.obj(
				{ prefix: S.str(), suffix: S.str(), decimals: S.num(), percent: S.bool() },
				{ describe: 'format' }
			),
			hint: S.str()
		},
		finish: FINISH.calc
	},
	buttons: {
		props: {
			buttons: S.list(
				S.obj(
					{
						label: S.str({ required: true }),
						message: S.str(),
						open: S.str(),
						style: S.enum(['primary', 'default'])
					},
					{ describe: 'button' }
				),
				{ required: true, min: 1, max: BOUNDS.maxButtons }
			)
		},
		finish: FINISH.buttons
	}
};

/** Validate one block and return it with defaults applied and unknown keys gone. */
function checkElement(node, path, depth, state) {
	if (!isPlainObject(node)) fail(`${path} must be an object, got ${typeName(node)}`);
	const type = node.type;
	if (typeof type !== 'string') fail(`${path}.type must be a string naming the element, got ${describeValue(type)}`);
	const element = ELEMENTS[type];
	if (element === undefined) fail(`${path}.type "${type}" is not a known element; valid types: ${TYPES.join(', ')}`);
	state.nodes += 1;
	if (state.nodes > state.maxNodes)
		fail(`the view holds more than ${state.maxNodes} elements; split it into separate calls`);
	if (depth > BOUNDS.maxDepth) fail(`${path} nests blocks deeper than ${BOUNDS.maxDepth} levels`);
	const view = { type };
	for (const key of Object.keys(node)) {
		if (key === 'type') continue;
		const rule = element.props[key];
		if (rule === undefined)
			fail(
				`${path} (${type} element) has the unknown key "${key}"; allowed keys are: ${Object.keys(element.props).join(', ') || '(none)'}`
			);
		view[key] = checkValue(node[key], rule, `${path}.${key}`, `${type} element`, depth, state);
	}
	for (const key of Object.keys(element.props))
		if (element.props[key].required === true && view[key] === undefined)
			fail(`${path} (${type} element) is missing the required key "${key}"`);
	if (element.finish !== undefined) element.finish(view, path);
	return view;
}

/** Validate one value against one rule, returning its normalized form. */
function checkValue(value, rule, path, owner, depth, state) {
	switch (rule.kind) {
		case 'string':
			if (typeof value !== 'string') fail(`${path} must be a string, got ${describeValue(value)}`);
			return value;
		case 'number':
			if (typeof value !== 'number' || !Number.isFinite(value))
				fail(`${path} must be a finite number, got ${describeValue(value)}`);
			return value;
		case 'boolean':
			if (typeof value !== 'boolean') fail(`${path} must be a boolean, got ${describeValue(value)}`);
			return value;
		case 'scalar':
			if (typeof value === 'number' && !Number.isFinite(value)) fail(`${path} must be a finite number, got ${value}`);
			if (!isScalar(value)) fail(`${path} must be a string, number, or boolean, got ${describeValue(value)}`);
			return value;
		case 'enum':
			if (!rule.values.includes(value))
				fail(`${path} must be one of: ${rule.values.join(', ')} (got ${JSON.stringify(value)})`);
			return value;
		case 'array': {
			if (!Array.isArray(value)) fail(`${path} must be an array, got ${describeValue(value)}`);
			const min = rule.min ?? 0;
			if (value.length < min) fail(`${path} must not be empty${min > 1 ? `; it needs at least ${min} entries` : ''}`);
			if (rule.max !== undefined && value.length > rule.max)
				fail(`${path} has ${value.length} entries; the maximum is ${rule.max}`);
			return value.map((item, index) => checkValue(item, rule.item, `${path}[${index}]`, owner, depth, state));
		}
		case 'object': {
			if (!isPlainObject(value)) fail(`${path} must be an object, got ${describeValue(value)}`);
			const props = rule.props ?? {};
			const label = rule.describe ?? owner;
			const out = {};
			for (const key of Object.keys(value)) {
				const sub = props[key];
				if (sub === undefined)
					fail(`${path} (${label}) has the unknown key "${key}"; allowed keys are: ${Object.keys(props).join(', ') || '(none)'}`);
				out[key] = checkValue(value[key], sub, `${path}.${key}`, label, depth, state);
			}
			for (const key of Object.keys(props))
				if (props[key].required === true && out[key] === undefined)
					fail(`${path} (${label}) is missing the required key "${key}"`);
			if (rule.finish !== undefined) rule.finish(out, path);
			return out;
		}
		case 'map': {
			if (!isPlainObject(value)) fail(`${path} must be an object, got ${describeValue(value)}`);
			const out = {};
			for (const key of Object.keys(value))
				out[key] = checkValue(value[key], rule.value, `${path}.${key}`, owner, depth, state);
			return out;
		}
		case 'elements': {
			if (!Array.isArray(value)) fail(`${path} must be an array of blocks, got ${describeValue(value)}`);
			const min = rule.min ?? 0;
			if (value.length < min) fail(`${path} must hold at least ${min} block(s)`);
			return value.map((block, index) => checkElement(block, `${path}[${index}]`, depth + 1, state));
		}
		default:
			fail(`${path} hit an internal validation rule "${rule.kind}"`);
	}
}

/**
 * Validate one `render_ui` argument object and return the normalized spec the
 * client renders. Unknown keys, wrong shapes, and bound violations all fail
 * with a message naming the offending path.
 * @param args - the model's raw arguments.
 * @param limits - `{ maxBlocks, maxNodes }` from plugin config.
 * @returns the normalized spec, ready to publish on the Tool result.
 */
export function validateAndNormalize(args, limits) {
	if (!isPlainObject(args)) fail(`the arguments must be a JSON object, got ${typeName(args)}`);
	const spec = {};
	for (const key of Object.keys(args)) {
		if (key === 'title' || key === 'summary') {
			if (typeof args[key] !== 'string') fail(`${key} must be a string, got ${describeValue(args[key])}`);
			spec[key] = args[key];
			continue;
		}
		if (key !== 'blocks') fail(`the unknown top-level key "${key}"; allowed keys are: title, summary, blocks`);
	}
	const blocks = args.blocks;
	if (blocks === undefined) fail('blocks is required');
	if (!Array.isArray(blocks)) fail(`blocks must be an array of blocks, got ${describeValue(blocks)}`);
	if (blocks.length === 0) fail('blocks must not be empty');
	if (blocks.length > limits.maxBlocks)
		fail(`the view has ${blocks.length} top-level blocks; the maximum is ${limits.maxBlocks}`);
	const state = { nodes: 0, maxNodes: limits.maxNodes };
	spec.blocks = blocks.map((block, index) => checkElement(block, `blocks[${index}]`, 1, state));
	return spec;
}

// #endregion validation

// #region tool definition

/** Model-facing summary: purpose, when to use it, and where the catalog lives. */
export const TOOL_DESCRIPTION = [
	'Render one interactive view inside the conversation instead of describing it in prose.',
	'Use it when the user must compare options, read data, follow a sequence, or try different values — not for an ordinary explanation, and not as decoration.',
	'Sorting, tabs, and input fields respond in the browser; a button or form submit sends a prepared follow-up message back to you.',
	'At most one view per answer, and keep your prose as the primary reply.',
	`Read the ${SKILL_NAME} skill for the element catalog before your first call.`
].join(' ');

/** Raw JSON Schema for the arguments. `execute` enforces the catalog itself. */
export const PARAMETERS = {
	type: 'object',
	additionalProperties: false,
	required: ['blocks'],
	properties: {
		title: {
			type: 'string',
			description: 'Short heading shown above the view. Omit it when the view needs no title.'
		},
		summary: {
			type: 'string',
			description: 'One line under the title. State the takeaway, not a restatement of the blocks.'
		},
		blocks: {
			type: 'array',
			description: `View content, rendered in order. Read the ${SKILL_NAME} skill for every element type and its fields.`,
			items: {
				type: 'object',
				additionalProperties: true,
				required: ['type'],
				properties: {
					type: { type: 'string', enum: TYPES, description: 'Element type.' }
				}
			}
		}
	}
};

/** The element types this view uses, in order of first appearance and deduplicated. */
function summariseKinds(spec) {
	const kinds = [];
	const walk = (blocks) => {
		for (const block of blocks) {
			if (!kinds.includes(block.type)) kinds.push(block.type);
			if (block.blocks !== undefined) walk(block.blocks);
			for (const tab of block.tabs ?? []) walk(tab.blocks);
		}
	};
	walk(spec.blocks);
	return kinds;
}

/**
 * Register the tool, the optional posture section, and the catalog skill.
 * @param ctx - Host services (`tools`, `skills`, `systemPrompt`).
 * @param config - patch-provided config; every key is optional.
 */
export function apply(ctx, config) {
	const settings = normalizeConfig(config, (message) => {
		const logger = ctx.logger ?? console;
		(logger.warn ?? console.warn).call(logger, message);
	});
	if (!settings.enabled) return;
	const limits = { maxBlocks: settings.maxBlocks, maxNodes: settings.maxNodes };

	const description = `${TOOL_DESCRIPTION}${settings.extraGuidance === '' ? '' : ` ${settings.extraGuidance}`}`;
	const skills = ctx.get('skills');
	ctx.tools.register({
		name: TOOL_NAME,
		description: skills === undefined ? `${description}\n\n${CATALOG}` : description,
		parameters: PARAMETERS,
		timeoutMs: 5000,
		output: {
			// The normalized spec is an opaque lossless JSON value: the registry
			// accepts any JSON here, and the model never reads it.
			schema: {},
			render: (_args, value) => [
				{
					type: 'text',
					text: `Rendered a ${value.blocks.length}-block interactive view (${summariseKinds(value).join(', ')})${
						value.title === undefined ? '' : ` titled "${value.title}"`
					}.`
				}
			],
			// The client's primary channel. Absent on the PTC dispatch path,
			// where the client falls back to the call's `argsRaw`.
			presentationMeta: (_args, value) => value
		},
		execute: (args) => validateAndNormalize(args, limits)
	});

	const section = POSTURE_SECTIONS[settings.posture];
	if (section !== undefined) {
		ctx.systemPrompt.section({
			name: 'intelligent-ui',
			order: settings.promptOrder,
			text: `${section}${settings.extraGuidance === '' ? '' : ` ${settings.extraGuidance}`}`
		});
	}

	if (skills !== undefined) {
		ctx.skills.register({
			name: SKILL_NAME,
			source: 'runtime',
			description: `Element catalog for the render_ui tool: every block type and its fields, the input-field kinds, the calc expression grammar, and worked examples.`,
			whenToUse:
				'Before the first render_ui call of a session, and whenever a block field, an input field, or a calc expression is unclear.',
			content: CATALOG
		});
	}
}

/**
 * Validate patch-provided config. A local plugin cannot project a Config schema
 * (schemastery does not resolve here), so this is the whole contract: invalid
 * values fail loudly, unknown keys warn and are ignored.
 * @param config - raw config from `cordis.patch.yml`, or undefined.
 * @param warn - sink for unknown-key warnings.
 * @returns resolved settings.
 */
export function normalizeConfig(config, warn) {
	if (config !== undefined && !isPlainObject(config)) throw new Error('dsh-intelligent-ui: config must be a mapping');
	const raw = config ?? {};
	const known = ['enabled', 'posture', 'maxBlocks', 'maxNodes', 'promptOrder', 'extraGuidance'];
	for (const key of Object.keys(raw))
		if (!known.includes(key)) warn(`dsh-intelligent-ui: ignoring the unknown config key "${key}" (known: ${known.join(', ')})`);

	const readBool = (key, fallback) => {
		const value = raw[key];
		if (value === undefined) return fallback;
		if (typeof value !== 'boolean') throw new Error(`dsh-intelligent-ui: config.${key} must be a boolean`);
		return value;
	};
	const readInt = (key, fallback) => {
		const value = raw[key];
		if (value === undefined) return fallback;
		if (!Number.isSafeInteger(value) || value < 1)
			throw new Error(`dsh-intelligent-ui: config.${key} must be a positive integer`);
		return value;
	};
	const settings = {
		enabled: readBool('enabled', true),
		posture: raw.posture ?? 'auto',
		maxBlocks: readInt('maxBlocks', 40),
		maxNodes: readInt('maxNodes', 240),
		promptOrder: raw.promptOrder ?? 3200,
		extraGuidance: raw.extraGuidance ?? ''
	};
	if (!Object.hasOwn(POSTURE_SECTIONS, settings.posture) && settings.posture !== 'auto')
		throw new Error(
			`dsh-intelligent-ui: config.posture must be one of: auto, ${Object.keys(POSTURE_SECTIONS).join(', ')}`
		);
	if (typeof settings.promptOrder !== 'number' || !Number.isFinite(settings.promptOrder))
		throw new Error('dsh-intelligent-ui: config.promptOrder must be a number');
	if (typeof settings.extraGuidance !== 'string') throw new Error('dsh-intelligent-ui: config.extraGuidance must be a string');
	if (settings.maxNodes < settings.maxBlocks)
		throw new Error('dsh-intelligent-ui: config.maxNodes must be greater than or equal to config.maxBlocks');
	return settings;
}

// #endregion tool definition

/**
 * Sandbox smoke test for dsh-intelligent-ui.
 *
 * Part 1 exercises the Host half directly: the tool definition, the config
 * contract, and every validation rule (positive and negative).
 * Part 2 loads client.js in a Node `vm` context with browser and React stubs
 * and exercises the real browser logic: spec resolution from `meta` and from
 * `argsRaw`, the truncated-JSON repair, and the calc expression engine.
 *
 * No Harness process, no browser, and no network are involved.
 *
 * Run: node test/smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import assert from 'node:assert/strict';

import {
	CATALOG,
	PARAMETERS,
	SKILL_NAME,
	TOOL_DESCRIPTION,
	TOOL_NAME,
	TYPES,
	VERSION,
	apply,
	normalizeConfig,
	validateAndNormalize
} from '../index.js';

let checks = 0;
const ok = (label) => {
	checks += 1;
	console.log(`  ok  ${label}`);
};

/** Assert that `fn` fails with a message containing `fragment`. */
function expectFail(label, fn, fragment) {
	let error;
	try {
		fn();
	} catch (caught) {
		error = caught;
	}
	assert.ok(error, `${label}: expected a failure`);
	assert.ok(
		error.message.includes(fragment),
		`${label}: expected the message to contain ${JSON.stringify(fragment)}, got ${JSON.stringify(error.message)}`
	);
	ok(`${label} → ${error.message}`);
}

// ---------------------------------------------------------------- fixtures

const LIMITS = { maxBlocks: 40, maxNodes: 240 };

/** One spec covering every element type, every field kind, and every nesting path. */
const FULL_SPEC = {
	title: 'カバレッジ',
	summary: '全要素を通す',
	blocks: [
		{ type: 'section', title: '見出し', subtitle: '補足', blocks: [{ type: 'text', text: '本文', style: 'lead' }] },
		{
			type: 'row',
			blocks: [
				{ type: 'stat', label: '売上', value: 1200, delta: '+12%', hint: '前月比' },
				{ type: 'stat', label: '件数', value: '48' }
			]
		},
		{ type: 'callout', tone: 'warn', title: '注意', text: '本文' },
		{ type: 'divider' },
		{ type: 'text', text: 'キャプション', style: 'caption' },
		{
			type: 'table',
			title: '表',
			sortable: true,
			initialSort: { key: 'cost', dir: 'desc' },
			columns: [
				{ key: 'name', label: '名前' },
				{ key: 'cost', label: '費用', align: 'right', format: 'number' },
				{ key: 'share', label: '比率', align: 'right', format: 'percent' }
			],
			rows: [{ name: 'A', cost: 1200, share: 0.4 }, { name: 'B', cost: 800 }]
		},
		{
			type: 'chart',
			kind: 'bar',
			title: 'グラフ',
			yLabel: '百万円',
			categories: ['Q1', 'Q2'],
			stacked: true,
			series: [
				{ label: '2026', data: [1, 2], color: '--dsw-alias-brand-primary' },
				{ label: '2025', data: [3, 4] }
			]
		},
		{
			type: 'comparison',
			title: '比較',
			columns: [{ label: 'A', hint: '従量' }, { label: 'B' }],
			rows: [
				{ attribute: '月額', values: ['¥3/回', '¥12,000'] },
				{ attribute: '総額', values: ['¥540,000', '¥432,000'] }
			]
		},
		{
			type: 'timeline',
			title: '手順',
			items: [
				{ label: '調査', detail: '現状を確認', at: '1週目' },
				{ label: '実装' }
			]
		},
		{
			type: 'diagram',
			title: '構成',
			layout: 'tree',
			nodes: [
				{ id: 'a', label: '入力', detail: 'spec', group: 'ui' },
				{ id: 'b', label: '検証', detail: 'Host', group: 'host' }
			],
			edges: [{ from: 'a', to: 'b', label: 'JSON' }]
		},
		{
			type: 'tabs',
			tabs: [
				{ label: '概要', blocks: [{ type: 'text', text: '概要' }] },
				{ label: '詳細', blocks: [{ type: 'text', text: '詳細' }] }
			]
		},
		{
			type: 'inputs',
			title: '条件',
			fields: [
				{ name: 'calls', label: 'コール数', kind: 'range', min: 0, max: 100, step: 5, value: 20 },
				{ name: 'plan', label: 'プラン', kind: 'select', value: 'b', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
				{ name: 'note', label: 'メモ', kind: 'textarea', placeholder: '任意' },
				{ name: 'urgent', label: '急ぎ', kind: 'checkbox', value: false },
				{ name: 'count', label: '数量', kind: 'number', value: 3, min: 1, max: 9, hint: '1〜9' },
				{ name: 'who', label: '担当', kind: 'text', value: 'me' }
			],
			submit: { label: '送る', message: '{{calls}}回・{{plan}}・{{who}}' }
		},
		{
			type: 'calc',
			label: '月額',
			expr: "if(plan == 'b', 12000, calls * 3)",
			format: { prefix: '¥', decimals: 0, percent: false, suffix: '/月' },
			hint: '概算'
		},
		{
			type: 'buttons',
			buttons: [
				{ label: '見積もり', message: '見積もって', style: 'primary' },
				{ label: '開く', open: 'report.md' },
				{ label: 'おまかせ' , message: '任せる' }
			]
		}
	]
};

/** A stub Host context recording every registration. */
function stubContext({ skills = true } = {}) {
	const captured = { tools: [], sections: [], skills: [], warnings: [] };
	const services = skills
		? { skills: { register: (skill) => void captured.skills.push(skill) } }
		: {};
	const ctx = {
		logger: { warn: (message) => void captured.warnings.push(message) },
		get: (name) => services[name],
		tools: { register: (definition) => void captured.tools.push(definition) },
		systemPrompt: { section: (section) => void captured.sections.push(section) },
		...(skills ? { skills: services.skills } : {})
	};
	return { ctx, captured };
}

// ---------------------------------------------------------------- part 1: host half

console.log(`\nindex.js — dsh-intelligent-ui ${VERSION}`);

assert.equal(TYPES.length, 15, 'the catalog documents 15 element types');
ok(`TYPES has ${TYPES.length} element types: ${TYPES.join(', ')}`);

assert.equal(CATALOG.split('\n')[0], '# render_ui — element catalog');
for (const type of TYPES) assert.ok(CATALOG.includes(`\`${type}\``), `the catalog documents ${type}`);
ok('catalog.md documents every element type');

assert.equal(PARAMETERS.type, 'object');
assert.deepEqual(PARAMETERS.required, ['blocks']);
assert.equal(PARAMETERS.additionalProperties, false);
assert.deepEqual(PARAMETERS.properties.blocks.items.properties.type.enum, TYPES);
ok('PARAMETERS is an object-rooted JSON Schema whose enum is exactly TYPES');

assert.ok(TOOL_DESCRIPTION.includes(SKILL_NAME), 'the description routes the model to the catalog skill');
assert.ok(TOOL_DESCRIPTION.length < 700, 'the standing description stays short');
ok(`tool description routes to the ${SKILL_NAME} skill (${TOOL_DESCRIPTION.length} chars)`);

// --- config

assert.deepEqual(normalizeConfig(undefined, () => {}), {
	enabled: true,
	posture: 'auto',
	maxBlocks: 40,
	maxNodes: 240,
	promptOrder: 3200,
	extraGuidance: ''
});
assert.deepEqual(normalizeConfig({ enabled: false, posture: 'off', maxBlocks: 2, maxNodes: 5, promptOrder: 1, extraGuidance: 'x' }, () => {}), {
	enabled: false,
	posture: 'off',
	maxBlocks: 2,
	maxNodes: 5,
	promptOrder: 1,
	extraGuidance: 'x'
});
ok('normalizeConfig resolves defaults and accepts every documented key');

const warned = [];
normalizeConfig({ nope: 1 }, (message) => void warned.push(message));
assert.equal(warned.length, 1);
assert.ok(warned[0].includes('nope'));
ok('normalizeConfig warns on an unknown key');

expectFail('config: bad posture', () => normalizeConfig({ posture: 'loud' }, () => {}), 'config.posture must be one of');
expectFail('config: bad maxBlocks', () => normalizeConfig({ maxBlocks: 0 }, () => {}), 'config.maxBlocks must be a positive integer');
expectFail('config: maxNodes < maxBlocks', () => normalizeConfig({ maxBlocks: 10, maxNodes: 5 }, () => {}), 'config.maxNodes must be greater than');
expectFail('config: bad extraGuidance', () => normalizeConfig({ extraGuidance: 5 }, () => {}), 'config.extraGuidance must be a string');
expectFail('config: not a mapping', () => normalizeConfig([1], () => {}), 'config must be a mapping');

// --- registration

const plain = stubContext();
apply(plain.ctx, undefined);
assert.equal(plain.captured.tools.length, 1);
assert.equal(plain.captured.skills.length, 1);
assert.equal(plain.captured.sections.length, 0, 'auto registers no prompt section');
const tool = plain.captured.tools[0];
assert.equal(tool.name, TOOL_NAME);
assert.equal(tool.parameters, PARAMETERS);
assert.equal(typeof tool.execute, 'function');
assert.equal(typeof tool.output.render, 'function');
assert.equal(typeof tool.output.presentationMeta, 'function');
assert.ok(!tool.description.includes('\n\n# render_ui'), 'with a skill registry the description stays short');
ok('apply registers render_ui, its skill, and no prompt section under auto');

const skill = plain.captured.skills[0];
assert.equal(skill.name, SKILL_NAME);
assert.equal(skill.source, 'runtime');
assert.equal(skill.content, CATALOG);
assert.ok(skill.description.length > 20 && skill.whenToUse.length > 20);
ok(`apply registers the ${SKILL_NAME} runtime skill`);

const noSkills = stubContext({ skills: false });
apply(noSkills.ctx, undefined);
assert.ok(noSkills.captured.skills.length === 0);
assert.ok(noSkills.captured.tools[0].description.includes('# render_ui — element catalog'));
ok('without a skill registry the description carries the catalog itself');

for (const posture of ['encourage', 'off']) {
	const captured = stubContext();
	apply(captured.ctx, { posture });
	assert.equal(captured.captured.sections.length, 1, `${posture} registers a prompt section`);
	const section = captured.captured.sections[0];
	assert.equal(section.name, 'intelligent-ui');
	assert.equal(section.order, 3200);
	assert.ok(!section.text.includes('blocks'), 'the section does not restate the catalog');
	ok(`posture ${posture} registers one policy sentence (${section.text.length} chars)`);
}

const disabled = stubContext();
apply(disabled.ctx, { enabled: false });
assert.equal(disabled.captured.tools.length + disabled.captured.skills.length, 0);
ok('enabled:false registers nothing');

const withGuidance = stubContext();
apply(withGuidance.ctx, { posture: 'encourage', extraGuidance: '社内用語は日本語で。' });
assert.ok(withGuidance.captured.sections[0].text.endsWith('社内用語は日本語で。'));
assert.ok(withGuidance.captured.tools[0].description.endsWith('社内用語は日本語で。'));
ok('extraGuidance reaches both the description and the section');

// --- happy path

const normalized = validateAndNormalize(FULL_SPEC, LIMITS);
assert.equal(normalized.title, 'カバレッジ');
assert.equal(normalized.blocks.length, 14, 'the top level omits stat, which the fixture nests in a row');
assert.deepEqual(
	[...new Set(normalized.blocks.map((block) => block.type))].sort(),
	TYPES.filter((type) => type !== 'stat').sort(),
	'every top-level element type round-trips'
);
assert.deepEqual(
	normalized.blocks.map((block) => block.type),
	['section', 'row', 'callout', 'divider', 'text', 'table', 'chart', 'comparison', 'timeline', 'diagram', 'tabs', 'inputs', 'calc', 'buttons'],
	'block order is preserved'
);
const byType = Object.fromEntries(normalized.blocks.map((block) => [block.type, block]));
assert.equal(byType.text.style, 'caption');
assert.equal(byType.table.rows[1].share, undefined, 'a missing cell stays missing');
assert.ok(!('share' in byType.table.rows[1]), 'normalization never invents undefined properties');
assert.equal(byType.diagram.layout, 'tree');
assert.equal(byType.calc.format.decimals, 0);
assert.equal(byType.inputs.fields[1].value, 'b');
assert.equal(byType.buttons.buttons[1].open, 'report.md');
assert.equal(byType.buttons.buttons[1].message, undefined);
assert.equal(byType.section.blocks[0].style, 'lead');
assert.deepEqual(byType.row.blocks.map((block) => block.value), [1200, '48']);
ok(`validateAndNormalize accepts a spec covering all ${TYPES.length} element types`);

const smaller = validateAndNormalize({ blocks: [{ type: 'divider' }] }, LIMITS);
assert.deepEqual(smaller, { blocks: [{ type: 'divider' }] });
ok('unknown optional keys are simply absent (no undefined leakage)');

const draft = validateAndNormalize(FULL_SPEC, LIMITS);
assert.ok(!('unknown' in draft));
assert.deepEqual(Object.keys(draft.blocks[0]), ['type', 'title', 'subtitle', 'blocks'], 'normalization preserves declaration order');
ok('the normalized spec preserves key order for stable rendering');

// --- model-facing error messages

expectFail('unknown element', () => validateAndNormalize({ blocks: [{ type: 'chartt' }] }, LIMITS), 'valid types: section, row');
expectFail(
	'unknown element key',
	() => validateAndNormalize({ blocks: [{ type: 'text', text: 'x', style: 'huge' }] }, LIMITS),
	'blocks[0].style must be one of: body, lead, caption (got "huge")'
);
expectFail(
	'unknown key names the allowed set',
	() => validateAndNormalize({ blocks: [{ type: 'chart', kind: 'bar', categories: ['a'], series: [{ label: 's', data: [1], colour: 'red' }] }] }, LIMITS),
	'blocks[0].series[0] (series) has the unknown key "colour"'
);
expectFail('missing required key', () => validateAndNormalize({ blocks: [{ type: 'callout', text: 'x' }] }, LIMITS), 'missing the required key "tone"');
expectFail('wrong scalar type', () => validateAndNormalize({ blocks: [{ type: 'stat', label: 'x', value: { a: 1 } }] }, LIMITS), 'blocks[0].value must be a string, number, or boolean');
expectFail(
	'non-finite number',
	() => validateAndNormalize({ blocks: [{ type: 'stat', label: 'x', value: Number.NaN }] }, LIMITS),
	'blocks[0].value must be a finite number, got NaN'
);
expectFail(
	'non-finite table cell',
	() => validateAndNormalize({ blocks: [{ type: 'table', columns: [{ key: 'a', label: 'A' }], rows: [{ a: Number.POSITIVE_INFINITY }] }] }, LIMITS),
	'blocks[0].rows[0].a must be a finite number, got Infinity'
);
expectFail('empty blocks', () => validateAndNormalize({ blocks: [] }, LIMITS), 'blocks must not be empty');
expectFail('blocks missing', () => validateAndNormalize({}, LIMITS), 'blocks is required');
expectFail('unknown top-level key', () => validateAndNormalize({ blocks: [{ type: 'divider' }], theme: 'x' }, LIMITS), 'the unknown top-level key "theme"');
expectFail('args not an object', () => validateAndNormalize([], LIMITS), 'the arguments must be a JSON object');
expectFail('title not a string', () => validateAndNormalize({ title: 3, blocks: [{ type: 'divider' }] }, LIMITS), 'title must be a string');
expectFail(
	'block not an object',
	() => validateAndNormalize({ blocks: ['text'] }, LIMITS),
	'blocks[0] must be an object'
);
expectFail(
	'empty nested blocks',
	() => validateAndNormalize({ blocks: [{ type: 'section', blocks: [] }] }, LIMITS),
	'blocks[0].blocks must hold at least 1 block(s)'
);

expectFail(
	'table: unknown column in a row',
	() => validateAndNormalize({ blocks: [{ type: 'table', columns: [{ key: 'a', label: 'A' }], rows: [{ b: 1 }] }] }, LIMITS),
	'blocks[0].rows[0] has the key "b", which is not a column; column keys are: a'
);
expectFail(
	'table: duplicate column key',
	() => validateAndNormalize({ blocks: [{ type: 'table', columns: [{ key: 'a', label: 'A' }, { key: 'a', label: 'B' }], rows: [{ a: 1 }] }] }, LIMITS),
	'uses the key "a" more than once'
);
expectFail(
	'table: initialSort key must exist',
	() => validateAndNormalize({ blocks: [{ type: 'table', columns: [{ key: 'a', label: 'A' }], rows: [{ a: 1 }], initialSort: { key: 'z', dir: 'asc' } }] }, LIMITS),
	'blocks[0].initialSort.key "z" is not one of the column keys: a'
);
expectFail(
	'chart: series width mismatch',
	() => validateAndNormalize({ blocks: [{ type: 'chart', kind: 'bar', categories: ['a', 'b'], series: [{ label: 's', data: [1] }] }] }, LIMITS),
	'has 1 values but categories has 2'
);
expectFail(
	'chart: pie takes one series',
	() =>
		validateAndNormalize(
			{ blocks: [{ type: 'chart', kind: 'pie', categories: ['a'], series: [{ label: 's', data: [1] }, { label: 't', data: [2] }] }] },
			LIMITS
		),
	'is a pie chart with 2 series'
);
expectFail(
	'comparison: row width mismatch',
	() =>
		validateAndNormalize(
			{ blocks: [{ type: 'comparison', columns: [{ label: 'A' }, { label: 'B' }], rows: [{ attribute: 'x', values: ['1'] }] }] },
			LIMITS
		),
	'has 1 values but there are 2 columns'
);
expectFail(
	'diagram: unknown edge endpoint',
	() =>
		validateAndNormalize(
			{ blocks: [{ type: 'diagram', nodes: [{ id: 'a', label: 'A' }], edges: [{ from: 'a', to: 'b' }] }] },
			LIMITS
		),
	'blocks[0].edges[0].to is "b", which is not a node id; node ids are: a'
);
expectFail(
	'diagram: duplicate node id',
	() =>
		validateAndNormalize(
			{ blocks: [{ type: 'diagram', nodes: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }] },
			LIMITS
		),
	'uses the id "a" more than once'
);
expectFail(
	'inputs: bad field name',
	() =>
		validateAndNormalize(
			{ blocks: [{ type: 'inputs', fields: [{ name: '2x', label: 'X', kind: 'text' }] }] },
			LIMITS
		),
	'is not an identifier'
);
expectFail(
	'inputs: select without options',
	() => validateAndNormalize({ blocks: [{ type: 'inputs', fields: [{ name: 'a', label: 'A', kind: 'select' }] }] }, LIMITS),
	'is a select field without options'
);
expectFail(
	'inputs: range without bounds',
	() => validateAndNormalize({ blocks: [{ type: 'inputs', fields: [{ name: 'a', label: 'A', kind: 'range' }] }] }, LIMITS),
	'is a range field; give it both min and max'
);
expectFail(
	'inputs: checkbox with a string value',
	() => validateAndNormalize({ blocks: [{ type: 'inputs', fields: [{ name: 'a', label: 'A', kind: 'checkbox', value: 'yes' }] }] }, LIMITS),
	'value must be a boolean for a checkbox'
);
expectFail(
	'inputs: duplicate field name',
	() =>
		validateAndNormalize(
			{ blocks: [{ type: 'inputs', fields: [{ name: 'a', label: 'A', kind: 'text' }, { name: 'a', label: 'B', kind: 'text' }] }] },
			LIMITS
		),
	'uses the name "a" more than once'
);
expectFail(
	'buttons: needs exactly one action',
	() => validateAndNormalize({ blocks: [{ type: 'buttons', buttons: [{ label: 'x' }] }] }, LIMITS),
	'needs exactly one of message or open'
);
expectFail(
	'buttons: rejects both actions',
	() => validateAndNormalize({ blocks: [{ type: 'buttons', buttons: [{ label: 'x', message: 'm', open: 'p' }] }] }, LIMITS),
	'needs exactly one of message or open'
);
expectFail('calc: empty expression', () => validateAndNormalize({ blocks: [{ type: 'calc', label: 'x', expr: '  ' }] }, LIMITS), 'expr must not be empty');
expectFail(
	'chart: unknown color key',
	() =>
		validateAndNormalize(
			{ blocks: [{ type: 'chart', kind: 'bar', categories: ['a'], series: [{ label: 's', data: [1], colors: 'x' }] }] },
			LIMITS
		),
	'has the unknown key "colors"'
);

// --- bounds

expectFail(
	'maxBlocks',
	() => validateAndNormalize({ blocks: Array.from({ length: 41 }, () => ({ type: 'divider' })) }, LIMITS),
	'the maximum is 40'
);
expectFail(
	'maxNodes counts nested elements',
	() =>
		validateAndNormalize(
			{ blocks: [{ type: 'section', blocks: Array.from({ length: 240 }, () => ({ type: 'divider' })) }] },
			LIMITS
		),
	'the view holds more than 240 elements'
);
expectFail('maxRows', () => validateAndNormalize({ blocks: [{ type: 'table', columns: [{ key: 'a', label: 'A' }], rows: Array.from({ length: 101 }, () => ({ a: 1 })) }] }, LIMITS), 'the maximum is 100');
expectFail(
	'maxSeriesPoints',
	() =>
		validateAndNormalize(
			{ blocks: [{ type: 'chart', kind: 'bar', categories: Array.from({ length: 201 }, (_, i) => `c${i}`), series: [{ label: 's', data: [1] }] }] },
			LIMITS
		),
	'the maximum is 200'
);
expectFail(
	'maxItems on a diagram',
	() =>
		validateAndNormalize(
			{ blocks: [{ type: 'diagram', nodes: Array.from({ length: 41 }, (_, i) => ({ id: `n${i}`, label: 'x' })) }] },
			LIMITS
		),
	'the maximum is 40'
);
expectFail(
	'nesting depth',
	() => {
		let block = { type: 'text', text: 'deep' };
		for (let i = 0; i < 7; i += 1) block = { type: 'section', blocks: [block] };
		validateAndNormalize({ blocks: [block] }, LIMITS);
	},
	'nests blocks deeper than 6 levels'
);
expectFail(
	'row needs at least two blocks',
	() => validateAndNormalize({ blocks: [{ type: 'row', blocks: [{ type: 'divider' }] }] }, LIMITS),
	'blocks[0].blocks must hold at least 2 block(s)'
);

// --- output

const rendered = tool.output.render({}, normalized);
assert.equal(rendered.length, 1);
assert.equal(rendered[0].type, 'text');
assert.equal(
	// Element types in render order, deduplicated: the nested text inside section comes first.
	'Rendered a 14-block interactive view (section, text, row, stat, callout, divider, table, chart, comparison, timeline, diagram, tabs, inputs, calc, buttons) titled "カバレッジ".',
	rendered[0].text
);
ok(`render → ${rendered[0].text}`);

assert.equal(tool.output.presentationMeta({}, normalized), normalized);
ok('presentationMeta publishes the normalized spec as-is');

const renderedUntitled = tool.output.render({}, smaller);
assert.equal(renderedUntitled[0].text, 'Rendered a 1-block interactive view (divider).');
ok('render omits the title clause when there is no title');

// --- catalog size, as a context-budget signal

const catalogLines = CATALOG.split('\n').length;
assert.ok(catalogLines > 80 && catalogLines < 200, 'the catalog stays a single loadable document');
assert.ok(!/^\|/m.test(CATALOG), 'no markdown tables: this body is read as prose');
assert.ok(CATALOG.includes('0.42'), 'the catalog states that percent cells are fractions');
assert.ok(CATALOG.includes("option's `label`"), 'the catalog states what {{name}} substitutes for a select');
ok(`catalog.md documents all ${TYPES.length} types in ${catalogLines} lines / ${Buffer.byteLength(CATALOG)} bytes`);

console.log(`\npart 1: ${checks} checks passed`);

// ---------------------------------------------------------------- part 2: client half

/**
 * Load client.js the way the app does: evaluate it with `window.__ModuleLoader__`
 * installed, then take the factory's module. It is evaluated in this realm (via
 * `runInThisContext`) so the values it produces compare directly in assertions.
 */
function loadClientBundle() {
	let loaded;
	const listeners = [];
	globalThis.window = { __ModuleLoader__: { load: (entry) => (loaded = entry) } };
	globalThis.document = {
		head: { append: (tag) => listeners.push(tag) },
		createElement: () => ({
			dataset: {},
			textContent: '',
			removed: false,
			remove() {
				this.removed = true;
			}
		})
	};
	/* Node defines navigator as a getter-only global. */
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		writable: true,
		value: { clipboard: { writeText: (text) => (listeners.push(text), Promise.resolve()) } }
	});
	vm.runInThisContext(readFileSync(fileURLToPath(new URL('../client.js', import.meta.url)), 'utf8'), { filename: 'client.js' });
	assert.ok(loaded, 'the bundle registers itself with the module loader');
	assert.equal(loaded.id, 'dsh-intelligent-ui');
	const module = loaded.factory((name) => {
		assert.equal(name, 'react', `the bundle must not import ${name}`);
		return reactStub;
	});
	return { module, listeners, sandbox: globalThis };
}

/** The smallest React that can build a tree, so components can be inspected headlessly. */
const reactStub = (() => {
	class Component {
		constructor(props) {
			this.props = props;
		}
		setState() {}
	}
	const module = {
		createElement(type, props, ...children) {
			const flat = [];
			const push = (child) => {
				if (Array.isArray(child)) child.forEach(push);
				else if (child !== null && child !== undefined && typeof child !== 'boolean') flat.push(child);
			};
			children.forEach(push);
			const withChildren = { ...(props ?? {}), children: flat.length === 0 ? undefined : flat.length === 1 ? flat[0] : flat };
			return { element: true, type, props: withChildren, children: flat };
		},
		Fragment: Symbol('Fragment'),
		Component,
		useId: () => 'test',
		useMemo: (factory) => factory(),
		useCallback: (factory) => factory,
		useRef: (initial) => ({ current: typeof initial === 'function' ? initial() : initial }),
		useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
		useEffect: () => {},
		createContext: () => ({ Provider: Symbol('Provider'), Consumer: Symbol('Consumer') }),
		/** No render scheduling in the stub: memoization is a pass-through. */
		memo: (component) => component
	};
	return module;
})();

/** Flatten an element tree into host nodes, rendering function and class components. */
function flatten(element, out = []) {
	if (element === null || element === undefined || typeof element !== 'object') return out;
	if (Array.isArray(element)) {
		element.forEach((child) => flatten(child, out));
		return out;
	}
	if (element.element !== true) return out;
	if (typeof element.type === 'symbol') {
		element.children.forEach((child) => flatten(child, out));
		return out;
	}
	if (typeof element.type === 'function') {
		const isClass = typeof element.type.prototype?.render === 'function';
		flatten(isClass ? new element.type(element.props).render() : element.type(element.props), out);
		return out;
	}
	out.push({ tag: element.type, props: element.props, text: textOf(element) });
	element.children.forEach((child) => flatten(child, out));
	return out;
}

/** All text inside an element, for content assertions. */
function textOf(element) {
	let text = '';
	const visit = (node) => {
		if (typeof node === 'string' || typeof node === 'number') text += String(node);
		else if (Array.isArray(node)) node.forEach(visit);
		else if (node !== null && typeof node === 'object' && node.element === true) node.children.forEach(visit);
	};
	visit(element);
	return text;
}

/** Every node carrying `className`, so a check can address one piece of the view. */
const byClass = (nodes, name) => nodes.filter((node) => typeof node.props.className === 'string' && node.props.className.split(/\s+/).includes(name));

const JA_STRINGS = {
	preparing: '表示を作成しています…',
	streaming: '描画中',
	unreadable: 'この表示を読み取れませんでした',
	rawSpec: '仕様 (JSON)',
	copyJson: 'JSON をコピー',
	copied: 'コピーしました',
	droppedBlocks: '表示できないブロックが 1 件ありました',
	omittedBlocks: '残り 2 件のブロックを省略しました',
	blockFailed: '「chart」を表示できませんでした',
	diagramHint: 'ノードを選ぶと詳細を表示します',
	calcFailed: '式を評価できません',
	settledNote: 'ビューは回答の下に表示しています'
};
/** A stand-in for the locale seat: keys plus params, so missing keys are obvious. */
const t = (key, params) =>
	JA_STRINGS[key] === undefined ? `MISSING:${key}` : String(JA_STRINGS[key]).replace(/\{(\w+)\}/g, (_, name) => String(params?.[name] ?? ''));

const bundle = loadClientBundle();

const captured = { slots: [], effects: [], dicts: undefined };
const clientCtx = {
	locale: {
		bind: () => t,
		register: (namespace, dicts) => {
			captured.dicts = { namespace, dicts };
			return () => {};
		},
		getLocale: () => ({ active: 'ja' })
	},
	effect: (run) => {
		const dispose = run();
		captured.effects.push({ dispose, label: run.name });
		return dispose;
	},
	slots: {
		inject: (name, register) => register(),
		register: (declaration, component) => {
			captured.slots.push({ declaration, component });
			return () => {};
		}
	}
};
bundle.module.apply(clientCtx);

assert.equal(captured.slots.length, 2);
assert.equal(captured.slots[0].declaration.name, 'tool.call.toolview');
assert.equal(captured.slots[0].declaration.key, TOOL_NAME, 'the slot key must equal the wire tool name');
assert.equal(captured.slots[0].declaration.locale, 'dsh-intelligent-ui');
assert.equal(captured.slots[1].declaration.name, 'conversation.chat.turnTail');
assert.equal(captured.slots[1].declaration.id, 'dsh-intelligent-ui', 'a list seat needs its own id');
assert.equal(captured.slots[1].declaration.order, -10, 'the view sorts before the shipped tails');
assert.equal(captured.slots[1].declaration.locale, 'dsh-intelligent-ui');
ok('apply registers the call row and the Turn tail that keeps the view visible');

assert.equal(captured.dicts.namespace, 'dsh-intelligent-ui');
for (const language of ['ja', 'en', 'zh']) {
	const dict = captured.dicts.dicts[language];
	assert.ok(dict, `the ${language} dictionary is registered`);
	for (const key of Object.keys(JA_STRINGS)) assert.equal(typeof dict[key], 'string', `${language}.${key}`);
}
ok('apply registers ja, en, and zh dictionaries with every key the view uses');

const styleTag = bundle.listeners.find((entry) => entry.dataset?.pluginCss === 'dsh-intelligent-ui');
assert.ok(styleTag, 'the stylesheet is injected');
assert.ok(styleTag.textContent.includes('.dsh-iui-card'));
assert.ok(!/:\s*#[0-9a-f]{3,6}\s*[;}]/i.test(styleTag.textContent.replace(/,\s*#[0-9a-f]{3,6}\)/gi, '')), 'colours come from theme tokens, not literals');
ok(`apply injects the plugin stylesheet (${styleTag.textContent.length} chars, theme tokens only)`);

const hook = bundle.sandbox.window.__dshIntelligentUi;
assert.ok(hook, 'apply installs the verification hook');

console.log('\nclient.js — pure logic');

// --- truncated JSON repair

assert.deepEqual(hook.looseJson('{"a":1}'), { a: 1 });
assert.deepEqual(hook.looseJson('  {"a":[1,2]}  '), { a: [1, 2] });
assert.deepEqual(hook.looseJson('{"title":"x","blocks":[{"type":"text","text":"hel'), { title: 'x', blocks: [{ type: 'text', text: 'hel' }] });
assert.deepEqual(hook.looseJson('{"blocks":[{"type":"stat","value":12'), { blocks: [{ type: 'stat', value: 12 }] });
assert.deepEqual(hook.looseJson('{"blocks":[{"type":"divider"},'), { blocks: [{ type: 'divider' }] });
assert.deepEqual(hook.looseJson('{"blocks":[{"type":"diagram","nodes":[{"id":"a","label":"A"},{"id":"b","lab'), {
	/* "lab is a half-written key, so the node keeps only its completed id. */
	blocks: [{ type: 'diagram', nodes: [{ id: 'a', label: 'A' }, { id: 'b' }] }]
});
assert.equal(hook.looseJson('{"blocks":'), undefined);
assert.equal(hook.looseJson('blocks: ['), undefined);
assert.equal(hook.looseJson(''), undefined);
assert.equal(hook.looseJson(undefined), undefined);
assert.deepEqual(hook.looseJson('{"z":1e'), { z: 1 });
assert.deepEqual(hook.looseJson('[{"type":"divider"'), [{ type: 'divider' }]);
assert.deepEqual(hook.looseJson('{"blocks":[{"type":"text","text":"a\\'), { blocks: [{ type: 'text', text: 'a' }] });
assert.deepEqual(hook.looseJson('{"title":"x","blo'), { title: 'x' }, 'a half-written key cannot be repaired');
ok('looseJson parses complete JSON and repairs a truncated streaming prefix');

// --- spec resolution

const metaSpec = { blocks: [{ type: 'text', text: 'ok' }] };
assert.deepEqual(hook.specFromBlock('result', { meta: metaSpec, call: { argsRaw: '{bad' } }), { state: 'ready', spec: metaSpec, source: 'meta' });
assert.deepEqual(hook.specFromBlock('result', { call: { argsRaw: JSON.stringify(metaSpec) } }), { state: 'ready', spec: metaSpec, source: 'args' });
assert.deepEqual(hook.specFromBlock('start', { argsRaw: JSON.stringify(metaSpec) }), { state: 'ready', spec: metaSpec, source: 'args' });
assert.deepEqual(hook.specFromBlock('preparing', {}), { state: 'preparing' });
assert.deepEqual(hook.specFromBlock('start', { argsRaw: '{"blocks":[{"type":' }), { state: 'streaming', raw: '{"blocks":[{"type":' });
assert.deepEqual(hook.specFromBlock('result', { call: { argsRaw: 'not json' } }), { state: 'failed', raw: 'not json' });
assert.deepEqual(hook.specFromBlock('result', {}), { state: 'failed', raw: '' });
ok('specFromBlock prefers meta, falls back to argsRaw, and reports each stage');

const mixed = hook.sanitizeSpec({ title: 'T', blocks: [{ type: 'text', text: 'a' }, { type: 'nope' }, null, { type: 'divider' }] });
assert.deepEqual(mixed.dropped, [1, 2]);
assert.equal(mixed.blocks.length, 2);
assert.equal(hook.sanitizeSpec({ blocks: [{ type: 'nope' }] }), undefined);
assert.equal(hook.sanitizeSpec({ blocks: [] }), undefined);
assert.equal(hook.sanitizeSpec('x'), undefined);
ok('sanitizeSpec drops undrawable blocks and reports how many');

// --- the calc expression engine

const run = (expression, scope = {}) => hook.runExpr(hook.compileExpr(expression), scope);
assert.deepEqual(run('1 + 2 * 3'), { value: 7 });
assert.deepEqual(run('(1 + 2) * 3'), { value: 9 });
assert.deepEqual(run('10 / 4'), { value: 2.5 });
assert.deepEqual(run('7 % 4'), { value: 3 });
assert.deepEqual(run('-3 + 1'), { value: -2 });
assert.deepEqual(run('2 > 1 && 1 > 2'), { value: false });
assert.deepEqual(run('1 > 2 || 2 > 1'), { value: true });
assert.deepEqual(run("plan == 'b' ? 12000 : calls * 3", { plan: 'b', calls: 5 }), { value: 12000 });
assert.deepEqual(run("plan == 'b' ? 12000 : calls * 3", { plan: 'a', calls: 5 }), { value: 15 });
assert.deepEqual(run("if(calls > 10, 'many', 'few')", { calls: 20 }), { value: 'many' });
assert.deepEqual(run('sum(1, 2, 3)'), { value: 6 });
assert.deepEqual(run('avg(2, 4)'), { value: 3 });
assert.deepEqual(run('round(3.14159, 2)'), { value: 3.14 });
assert.deepEqual(run('max(1, 9, 4)'), { value: 9 });
assert.deepEqual(run('min(1, 9, 4)'), { value: 1 });
assert.deepEqual(run('abs(0 - 5)'), { value: 5 });
assert.deepEqual(run('floor(2.9)'), { value: 2 });
assert.deepEqual(run('ceil(2.1)'), { value: 3 });
assert.deepEqual(run('sqrt(16)'), { value: 4 });
assert.deepEqual(run('pow(2, 10)'), { value: 1024 });
assert.deepEqual(run("'a' + 'b'"), { value: 'ab' });
assert.deepEqual(run('!false'), { value: true });
ok('the expression engine evaluates arithmetic, comparison, ternary, and the whitelist');

for (const [label, expression, expected] of [
	['unknown function', 'eval("1")', 'is not one of the allowed functions'],
	['constructor escape', 'constructor(1)', 'is not one of the allowed functions'],
	['member access', 'window.alert', 'cannot be used here'],
	['assignment', 'x = 1', '"=" cannot be used here'],
	['unknown input', 'missing + 1', 'is not a declared input'],
	['unclosed call', 'max(1, 2', '")" is missing'],
	['unclosed string', "if('a", 'is not closed']
]) {
	const result = run(expression);
	assert.ok(result.error !== undefined && result.error.includes(expected), `${label}: got ${JSON.stringify(result)}`);
	ok(`calc rejects ${label} → ${result.error}`);
}
assert.deepEqual(run('1 / 0'), { error: 'the result is not a finite number' });
assert.deepEqual(run('avg()'), { error: 'the result is not a finite number' });
ok('calc reports a non-finite result instead of rendering Infinity');

// --- formatting and interpolation

assert.equal(hook.formatValue(1234.567, undefined, 'en'), '1,234.57');
assert.equal(hook.formatValue(1200, { decimals: 0, prefix: '¥' }, 'ja'), '¥1,200');
assert.equal(hook.formatValue(0.42, { percent: true, decimals: 0 }, 'en'), '42%');
assert.equal(hook.formatValue(12, { suffix: ' 件' }, 'ja'), '12 件');
ok('formatValue handles grouping, prefix, suffix, decimals, and percent');

const spec = hook.sanitizeSpec(FULL_SPEC);
assert.deepEqual(hook.niceTicks(91), { max: 100, ticks: [0, 25, 50, 75, 100] }, 'a 91 axis rounds up to 100');
assert.deepEqual(hook.niceTicks(154), { max: 200, ticks: [0, 50, 100, 150, 200] });
assert.deepEqual(hook.niceTicks(0.42).ticks, [0, 0.2, 0.4, 0.6], 'small values keep readable steps');
assert.deepEqual(hook.niceTicks(0), { max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] }, 'an empty chart still gets an axis');
ok('the chart axis rounds to readable ticks instead of raw fractions');

assert.deepEqual(hook.initialValues(spec), { calls: 20, plan: 'b', note: '', urgent: false, count: 3, who: 'me' });
assert.equal(hook.interpolate('{{calls}}回・{{plan}}・{{who}}', spec, { calls: 20, plan: 'b', who: 'me' }), '20回・B・me');
assert.equal(hook.interpolate('{{urgent}}/{{note}}/{{unknown}}', spec, { urgent: false, note: '' }), '—//{{unknown}}');
ok('inputs seed from field defaults and {{name}} interpolation resolves labels');

// --- rendering every element type

const View = captured.slots[0].component;
const Tail = captured.slots[1].component;
const render = (block, phase = 'result') => flatten(View({ block, phase, t, cwd: '/work', openFile: (path) => (captured.opened = path), inputActions: { setDraft: (text) => (captured.draft = text), submit: () => (captured.submitted = true) } }));

const nodes = render({ meta: spec });
const texts = nodes.map((node) => node.text);
const has = (needle) => texts.some((text) => text.includes(needle));
for (const needle of [
	'カバレッジ',
	'全要素を通す',
	'見出し',
	'売上',
	'1,200',
	'注意',
	'キャプション',
	'名前',
	'A',
	'2026',
	'Q1',
	'月額',
	'従量',
	'調査',
	'現状を確認',
	'入力',
	'JSON',
	'概要',
	'コール数',
	'プラン',
	'¥',
	'見積もり'
]) {
	assert.ok(has(needle), `the view renders ${JSON.stringify(needle)}`);
}
ok(`the view renders every element type (${nodes.length} host nodes)`);

assert.equal(byClass(nodes, 'dsh-iui-section').length, 1);
assert.equal(byClass(nodes, 'dsh-iui-row').length, 1);
assert.equal(byClass(nodes, 'dsh-iui-stat').length, 2, 'the row holds two stats');
assert.equal(byClass(nodes, 'dsh-iui-callout-warn').length, 1);
assert.equal(byClass(nodes, 'dsh-iui-divider').length, 1);
assert.equal(nodes.filter((node) => node.tag === 'table').length, 1);
assert.equal(nodes.filter((node) => node.tag === 'svg').length, 2, 'one chart and one diagram');
assert.equal(byClass(nodes, 'dsh-iui-comparison-grid').length, 1);
assert.equal(byClass(nodes, 'dsh-iui-timeline-item').length, 2);
assert.equal(byClass(nodes, 'dsh-iui-tab').length, 2);
assert.equal(byClass(nodes, 'dsh-iui-field').length, 6);
assert.equal(byClass(nodes, 'dsh-iui-calc').length, 1);
assert.equal(byClass(nodes, 'dsh-iui-button').length, 5, 'one submit, one primary, one open, one default, one copy');
ok('each element type produces its own structure');

const bars = nodes.filter((node) => node.tag === 'rect' && node.props.className === 'dsh-iui-bar');
assert.equal(bars.length, 4, 'two categories × two series');
assert.ok(bars.every((bar) => bar.props.fill.startsWith('var(--dsh-iui-series-') || bar.props.fill.startsWith('var(--dsw-')), 'bar colours are theme tokens');
const diagramNodes = byClass(nodes, 'dsh-iui-node');
assert.equal(diagramNodes.length, 2);
assert.equal(diagramNodes[0].props.role, 'button', 'a diagram node is selectable');
ok('the chart draws token-coloured bars and the diagram makes nodes selectable');

// --- diagram edges: a line that stops in mid-air reads as a broken diagram

/** The view this plugin was reported to break: five nodes, a decision below, one label. */
const EDGE_SPEC = {
	blocks: [
		{
			type: 'diagram',
			layout: 'flow',
			nodes: [
				{ id: 'purpose', label: '会の目的' },
				{ id: 'model', label: '動かす対象' },
				{ id: 'dist', label: '配布手段' },
				{ id: 'risk', label: '未解決の齟齬' },
				{ id: 'mtg', label: '正式決定' }
			],
			edges: [
				{ from: 'purpose', to: 'model' },
				{ from: 'model', to: 'dist' },
				{ from: 'dist', to: 'mtg' },
				{ from: 'risk', to: 'mtg', label: '要確認' }
			]
		}
	]
};
const edgeView = render({ meta: hook.sanitizeSpec(EDGE_SPEC) });
const boxes = byClass(edgeView, 'dsh-iui-node-box');
const edgeLines = byClass(edgeView, 'dsh-iui-edge');
assert.equal(boxes.length, 5);
assert.equal(edgeLines.length, 5, 'three plain edges in one piece, plus the two around 要確認');
const drawn = edgeLines.map((line) => ({ x1: line.props.x1, y1: line.props.y1, x2: line.props.x2, y2: line.props.y2 }));
const boxSize = { width: boxes[0].props.width, height: boxes[0].props.height };
/** Node centres straight from the rendered boxes, so the check follows the real layout. */
const centres = new Map(
	EDGE_SPEC.blocks[0].nodes.map((node, index) => [
		node.id,
		{ x: boxes[index].props.x + boxSize.width / 2, y: boxes[index].props.y + boxSize.height / 2 }
	])
);
for (const edge of EDGE_SPEC.blocks[0].edges) {
	const from = centres.get(edge.from);
	const to = centres.get(edge.to);
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const length = Math.hypot(dx, dy);
	const ux = dx / length;
	const uy = dy / length;
	/* Computed here, not in the view: how far the centre line travels inside a box. */
	const trim = Math.min(boxSize.width / 2 / Math.abs(ux), boxSize.height / 2 / Math.abs(uy));
	/** Distance along the edge of a point that lies on it. */
	const along = (point) => (point.x - from.x) * ux + (point.y - from.y) * uy;
	/** Perpendicular distance from the edge line, so a neighbouring edge is not counted. */
	const across = (point) => Math.abs((point.x - from.x) * uy - (point.y - from.y) * ux);
	const own = drawn.filter((line) => {
		const ends = [
			{ x: line.x1, y: line.y1 },
			{ x: line.x2, y: line.y2 }
		];
		return ends.every((point) => across(point) < 1 && along(point) > -2 && along(point) < length + 2);
	});
	assert.ok(own.length > 0, `the ${edge.from}→${edge.to} edge is drawn`);
	const reached = own.flatMap((line) => [along({ x: line.x1, y: line.y1 }), along({ x: line.x2, y: line.y2 })]);
	assert.ok(Math.min(...reached) <= trim + 2, `${edge.from}→${edge.to} starts on its own box`);
	assert.ok(Math.max(...reached) >= length - trim - 2, `${edge.from}→${edge.to} reaches the far box`);
}
ok('every edge of the reported view is drawn box to box');

/** The helper's own contract, including the shapes the layout above never produces. */
const BOX = { width: 84, height: 30 };
const NEAR = { x: 74, y: 29 };
const FAR = { x: 222, y: 29 };
/** How far outside a node box centred on `at` a point sits (negative = inside it). */
const borderGap = (point, at) =>
	Math.max(Math.abs(point.x - at.x) - BOX.width / 2, Math.abs(point.y - at.y) - BOX.height / 2);
const anchored = (point, at) => Math.abs(borderGap(point, at)) <= 2;

const plainEdge = hook.diagramEdge(NEAR, FAR, BOX);
assert.equal(plainEdge.tail, undefined, 'an unlabelled edge is a single line');
assert.ok(anchored(plainEdge.start, NEAR) && anchored(plainEdge.end, FAR), 'an unlabelled edge meets both boxes');
assert.ok(plainEdge.head.x - plainEdge.start.x >= 60, 'an unlabelled edge spans its whole gap');
ok(`an unlabelled edge spans ${plainEdge.head.x - plainEdge.start.x} of the 64 units between the boxes`);

const fitting = hook.diagramEdge(NEAR, FAR, BOX, '要確認');
assert.ok(fitting.tail !== undefined, 'a label that fits splits the line');
assert.ok(anchored(fitting.start, NEAR) && anchored(fitting.end, FAR), 'a labelled edge still meets both boxes');
assert.ok(Math.abs(fitting.tail.x - fitting.head.x - 35) < 0.001, 'the gap is the label plus its padding');
assert.ok(fitting.head.x - fitting.start.x >= 6 && fitting.end.x - fitting.tail.x >= 6, 'the label leaves a piece on both sides');
ok('a 要確認 label interrupts its line by exactly 35 units and no more');

const crowded = hook.diagramEdge(NEAR, FAR, BOX, 'とても長いラベルで収まらない場合の確認用テキスト');
assert.equal(crowded.tail, undefined, 'a label too wide for the gap leaves the line in one piece');
assert.ok(anchored(crowded.start, NEAR) && anchored(crowded.end, FAR), 'the line still reaches both boxes');
assert.ok(crowded.label.text.endsWith('…') && crowded.label.y < crowded.start.y, 'the long label is trimmed and moves off the line');
ok('an over-long label moves beside the line instead of cutting it open');

const vertical = hook.diagramEdge(NEAR, { x: 74, y: 93 }, BOX, '要確認');
assert.equal(vertical.tail, undefined, 'a label cannot take a line that is all gap');
assert.ok(anchored(vertical.start, NEAR) && anchored(vertical.end, { x: 74, y: 93 }), 'a vertical edge meets both boxes');
assert.ok(vertical.label.x > vertical.start.x, 'a vertical label sits beside the line');

const diagonal = hook.diagramEdge(NEAR, { x: 296, y: 93 }, BOX, '要確認');
assert.ok(diagonal.tail !== undefined, 'a long diagonal has room for the label on the line');
assert.ok(anchored(diagonal.start, NEAR) && anchored(diagonal.end, { x: 296, y: 93 }), 'a diagonal edge meets both boxes');

assert.equal(hook.diagramEdge(NEAR, NEAR, BOX), undefined, 'two nodes on one spot draw no edge');
ok('vertical and diagonal edges keep both ends on their boxes and still show the label');

const calc = byClass(nodes, 'dsh-iui-calc-value')[0];
assert.equal(calc.text, '¥12,000/月', 'the calc reads the seeded input values');
ok(`calc evaluates against the current inputs → ${calc.text}`);

// --- interactions

const draftOf = (label) => {
	const button = byClass(nodes, 'dsh-iui-button').find((node) => node.text.includes(label));
	assert.ok(button, `the ${label} button exists`);
	captured.draft = undefined;
	captured.submitted = undefined;
	button.props.onClick();
	return captured.draft;
};
assert.equal(draftOf('見積もり'), '見積もって');
assert.equal(captured.submitted, true, 'a message button submits immediately');
assert.equal(draftOf('送る'), '20回・B・me', 'the submit message interpolates the current values');
const openButton = byClass(nodes, 'dsh-iui-button').find((node) => node.text.includes('開く'));
openButton.props.onClick();
assert.equal(captured.opened, '/work/report.md', 'a relative open path resolves against the session cwd');
ok('buttons draft and submit a message, or open a file');

const range = nodes.find((node) => node.props.type === 'range');
assert.equal(range.props.value, 20);
assert.equal(range.props.max, 100);
const select = nodes.find((node) => node.tag === 'select');
assert.equal(select.props.value, 'b');
assert.equal(select.props.children.length, 2, 'a select renders its options');
const checkbox = nodes.find((node) => node.props.type === 'checkbox');
assert.equal(checkbox.props.checked, false);
ok('inputs render as live controls bound to the seeded values');

// --- degradation paths

const preparing = render({}, 'preparing');
assert.ok(preparing.some((node) => node.text.includes(JA_STRINGS.preparing)));
const streaming = render({ argsRaw: '{"blocks":[{"type":' }, 'start');
assert.ok(streaming.some((node) => node.text.includes(JA_STRINGS.streaming)));
assert.ok(!streaming.some((node) => node.tag === 'pre'), 'a streaming prefix shows a skeleton, not raw JSON');
const failed = render({ call: { argsRaw: 'oops' } }, 'result');
assert.ok(failed.some((node) => node.text.includes(JA_STRINGS.unreadable)));
assert.ok(failed.some((node) => node.tag === 'pre' && node.text === 'oops'), 'an unreadable spec keeps the raw text for the user');
ok('preparing, streaming, and unreadable states each show the right card');

const partial = render({ meta: { blocks: [{ type: 'text', text: '描けた' }, { type: 'nope' }] } });
assert.ok(partial.some((node) => node.text.includes('描けた')), 'a drawable block still renders');
assert.ok(partial.some((node) => node.text.includes('1 件')), 'the dropped block is reported');
ok('an undrawable block degrades to a note instead of an empty view');

const noInput = flatten(View({ block: { meta: spec }, phase: 'result', t, cwd: '/work', openFile: undefined, inputActions: undefined }));
assert.equal(noInput.filter((node) => node.tag === 'svg').length, 2, 'the view still draws without the input seat');
assert.ok(hook.lastRender.interactive === false);
ok('the view renders without the composer seat (buttons simply do nothing)');

/** Spec shared by the row hand-off and the Turn tail checks. */
const TAIL_SPEC = { title: 'Tail', blocks: [{ type: 'text', text: 'beside the answer' }] };

// --- the row hands the settled view over to the Turn tail

const rowSnapshot = (status) => {
	const node = { kind: 'tool-call', location: { kind: 'turn', turn: { turn: 3, status } }, data: { root: { kind: 'tool-result', callId: 'call-9', call: { name: TOOL_NAME }, meta: TAIL_SPEC } } };
	return { order: ['a', 'b'], nodes: new Map([['a', { kind: 'user' }], ['b', node]]) };
};

assert.equal(hook.callStatus(rowSnapshot('open'), 'call-9'), 'open');
assert.equal(hook.callStatus(rowSnapshot('closed'), 'call-9'), 'closed');
assert.equal(hook.callStatus(rowSnapshot('open'), 'other'), 'unknown', 'an unloaded call falls back to unknown');
assert.equal(hook.callStatus({ order: ['b'], nodes: new Map([['b', { kind: 'tool-call', location: { kind: 'turn', turn: { turn: 3, status: 'closed' } }, data: { root: { kind: 'tool-result', callId: 'p', call: { name: 'run_code' }, subCalls: [{ phase: 'start', callId: 's', name: 'render_ui' }] } } }]]) }, 's'), 'closed', 'a PTC sub-call shares its parent row Turn');
assert.equal(hook.callStatus(undefined, 'call-9'), 'unknown');
assert.equal(hook.callStatus({ order: ['b'], nodes: new Map() }, 'call-9'), 'unknown');

const liveRow = flatten(View({ block: { meta: TAIL_SPEC }, phase: 'result', t, cwd: '/work', inputActions: undefined, callId: 'call-9', useChat: (select) => select(rowSnapshot('open')) }));
assert.equal(liveRow.filter((node) => node.props.className === 'dsh-iui-card').length, 1, 'an open Turn keeps the streaming card in the row');
assert.equal(hook.lastRender.shown, 'card');

const settledRow = flatten(View({ block: { meta: TAIL_SPEC }, phase: 'result', t, cwd: '/work', inputActions: undefined, callId: 'call-9', useChat: (select) => select(rowSnapshot('closed')) }));
assert.equal(settledRow.filter((node) => node.props.className === 'dsh-iui-card').length, 0, 'a settled Turn draws no second card');
assert.equal(byClass(settledRow, 'dsh-iui-settled').length, 1, 'the row points at the answer instead');
assert.ok(settledRow.some((node) => node.text === JA_STRINGS.settledNote), 'the pointer is localized');
assert.equal(hook.lastRender.shown, 'note');
assert.equal(hook.lastRender.turnStatus, 'closed');
ok('the call row streams its own card and steps aside once the Turn settles');

// --- the Turn tail that survives the folded Tool group


/** Minimal Chat snapshot: the tail reads only `locations.getTurn` and `nodes.get`. */
function fakeSnapshot(entries) {
	const nodes = new Map(entries.map((node, index) => [`n${index}`, node]));
	return {
		order: [...nodes.keys()],
		locations: {
			/** The real index is keyed by Turn NUMBER, never by a TurnLocation. */
			getTurn: (turn) => (turn === 7 ? [...nodes.keys()] : [])
		},
		nodes
	};
}

const settledCall = (name, meta) => ({
	kind: 'tool-call',
	data: { root: { kind: 'tool-result', callId: `c-${name}`, call: { name, argsRaw: '{}' }, ...(meta === undefined ? {} : { meta }) } }
});
const runningCall = (name, argsRaw) => ({ kind: 'tool-call', data: { root: { phase: 'start', callId: `c-${name}`, name, argsRaw } } });

const snapshot = fakeSnapshot([
	{ kind: 'assistant-step', data: { blocks: [] } },
	settledCall('bash'),
	settledCall(TOOL_NAME, TAIL_SPEC),
	runningCall(TOOL_NAME, '{"blocks":[{"type":"text","text":"live"}]}'),
	{ kind: 'tool-call', visibility: 'hidden', data: { root: { kind: 'tool-result', callId: 'c-hidden', call: { name: TOOL_NAME }, meta: TAIL_SPEC } } },
	{ kind: 'tool-call', data: { root: { kind: 'tool-result', callId: 'c-null', call: null } } }
]);

const closedTurn = { turn: 7, status: 'closed' };
const views = hook.turnViews(snapshot, closedTurn);
assert.equal(views.length, 2, 'one settled view and one still-running view, and nothing else');
assert.deepEqual(views.map((entry) => entry.phase), ['result', 'start']);
assert.equal(views[0].block.meta, TAIL_SPEC, 'the settled view renders from the Host meta');
assert.deepEqual(hook.turnViews(undefined, closedTurn), [], 'no snapshot means no views');
assert.deepEqual(hook.turnViews(snapshot, undefined), [], 'no turn means no views');

/* PTC: a run_code block owns its nested calls, which are not nodes of their own. */
const ptcSnapshot = fakeSnapshot([
	{
		kind: 'tool-call',
		location: { kind: 'turn', turn: { turn: 7, status: 'closed' } },
		data: {
			root: {
				kind: 'tool-result',
				callId: 'p-1',
				call: { name: 'run_code', argsRaw: '{}' },
				subCalls: [
					{ phase: 'start', callId: 's-0', parentCallId: 'p-1', name: 'bash', argsRaw: '{}', subCalls: [] },
					{ kind: 'tool-result', callId: 's-1', parentCallId: 'p-1', call: { name: TOOL_NAME, argsRaw: '{}' }, meta: TAIL_SPEC, subCalls: [] }
				]
			}
		}
	}
]);
const ptcViews = hook.turnViews(ptcSnapshot, 7);
assert.equal(ptcViews.length, 1, 'a nested render_ui call is found through its parent');
assert.equal(ptcViews[0].key, 's-1');
assert.equal(ptcViews[0].phase, 'result');
assert.equal(ptcViews[0].block.meta, TAIL_SPEC);
assert.equal(hook.callStatus(ptcSnapshot, 's-1'), 'closed', 'a nested call resolves its parent Turn');
assert.equal(hook.callStatus(ptcSnapshot, 'p-1'), 'closed', 'the parent call still resolves');
assert.equal(hook.turnViews(snapshot, { turn: 7, status: 'closed' }).length, 2, 'a TurnLocation is unwrapped to its number');
assert.deepEqual(hook.turnViews(snapshot, 8), [], 'another Turn has its own nodes');
assert.deepEqual(hook.turnViews({ locations: {}, nodes: new Map() }, closedTurn), [], 'a host without the location index is tolerated');
ok('turnViews selects only the render_ui calls of one Turn');

const tailProps = (turn) => ({
	turn,
	openFile: () => {},
	inputActions: undefined,
	t,
	locale: 'ja',
	sessionId: 's1',
	useChat: (select) => select(snapshot),
	useSessions: (select) => select({ byId: { s1: { cwd: '/work' } } })
});

assert.deepEqual(flatten(Tail(tailProps({ turn: 7, status: 'open' }))), [], 'the open Turn keeps its one live copy in the call row');
assert.ok(flatten(Tail(tailProps({ turn: 7, status: 'unknown' }))).some((node) => node.props.className === 'dsh-iui-tail'), 'only an explicitly open Turn suppresses the tail');
const tailTree = Tail(tailProps(closedTurn));
const tailNodes = flatten(tailTree);
const tailRoot = tailNodes.find((node) => node.props.className === 'dsh-iui-tail');
assert.ok(tailRoot, 'the closed Turn contributes a tail container');
assert.equal(tailRoot.props['data-iui-tail'], '7');
assert.equal(tailNodes.filter((node) => node.props.className === 'dsh-iui-card').length, 2, 'each selected call draws its own card');
assert.ok(tailNodes.some((node) => node.text === 'beside the answer'), 'the card carries the spec');
assert.deepEqual(hook.lastTail, { turn: 7, closed: true, views: 2 });
assert.deepEqual(flatten(Tail({ turn: closedTurn, t, locale: 'ja' })), [], 'a host without store hooks renders nothing instead of throwing');
ok('the Turn tail shows the settled view and stays out of the way while the Turn is open');

// --- the boundary that contains a broken block

/** Raw element walk, so a component can be inspected without rendering it. */
function collectElements(root, predicate, out = []) {
	if (root === null || typeof root !== 'object') return out;
	if (Array.isArray(root)) {
		root.forEach((child) => collectElements(child, predicate, out));
		return out;
	}
	if (root.element !== true) return out;
	if (predicate(root)) out.push(root);
	root.children.forEach((child) => collectElements(child, predicate, out));
	return out;
}

/* Walk the component chain by hand: a function element's children only exist once it renders. */
const view = View({ block: { meta: spec }, phase: 'result', t, cwd: '/work', openFile: () => {}, inputActions: undefined });
const card = view.type(view.props);
const cardTree = card.type(card.props);
const boundaries = collectElements(cardTree, (element) => typeof element.type === 'function' && element.type.name === 'BlockBoundary');
assert.equal(boundaries.length, 14, 'every top-level block is wrapped in a boundary');
const Boundary = boundaries[0].type;
assert.deepEqual(Boundary.getDerivedStateFromError(), { failed: true });
const failedBlock = new Boundary({ type: 'chart', t });
failedBlock.state = { failed: true };
const fallback = flatten(failedBlock.render());
assert.deepEqual(fallback.map((node) => node.text), ['「chart」を表示できませんでした']);
ok('one broken block degrades to a localized note inside its own boundary');

// --- effect disposal

for (const effect of captured.effects) effect.dispose();
assert.equal(styleTag.removed, true, 'the stylesheet is removed again');
assert.equal(bundle.sandbox.window.__dshIntelligentUi, undefined, 'the verification hook is removed again');
ok('disposing the plugin removes the stylesheet and the hook');

console.log(`\npart 2: ${checks} checks passed in total`);

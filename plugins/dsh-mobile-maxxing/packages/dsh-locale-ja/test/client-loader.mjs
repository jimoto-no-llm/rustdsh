/**
 * Materialize the generated browser client the way DSH's client module loader
 * does, instead of importing it as an ES module.
 *
 * The Host concatenates every plugin's client file verbatim into a classic
 * <script> batch, so a client bundle may only call
 * window.__ModuleLoader__.load({ id, factory }). The loader queues that
 * registration, materializes the factory once on first import, and reads
 * { inject, apply } from the returned exports. This helper runs the file in a
 * VM context with a capturing window, then calls the factory with a
 * synchronous require that no locale bundle should need.
 */

import assert from 'node:assert/strict';
import vm from 'node:vm';

/** Host-realm plain copy of a value built inside the VM realm. */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/**
 * @param {string} source generated client.js text
 * @param {{ filename?: string }} [options]
 */
export function loadClientModule(source, { filename = 'client.js' } = {}) {
	const registrations = [];
	const sandbox = {
		window: {
			__ModuleLoader__: {
				load(registration) {
					registrations.push(registration);
				},
			},
		},
	};
	vm.createContext(sandbox);
	vm.runInContext(source, sandbox, { filename });

	assert.equal(registrations.length, 1, filename + ' must register exactly one browser module');
	const [registration] = registrations;
	assert.equal(typeof registration, 'object', filename + ' must pass a registration object to __ModuleLoader__.load');
	assert.equal(typeof registration.id, 'string', filename + ' registration must carry a string id');
	assert.equal(typeof registration.factory, 'function', filename + ' registration must carry a factory');

	const exports = registration.factory((specifier) => {
		throw new Error(filename + ' requested external "' + specifier + '" but the locale bundle needs none');
	});
	assert.equal(typeof exports, 'object', filename + ' factory must return its module exports');

	return {
		registration,
		exports,
		language: plain(exports.language),
		dictionaries: plain(exports.dictionaries),
		inject: plain(exports.inject),
		apply: exports.apply,
	};
}

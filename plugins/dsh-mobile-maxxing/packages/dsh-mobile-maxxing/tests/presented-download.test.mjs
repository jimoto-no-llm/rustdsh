/**
 * Host tests for the presented-file download route
 * (GET /api/rdsh-mobile-ux/download).
 *
 * The route is mounted through the same fakes as the live-speed tests, but
 * answered through a real HTTP server so the streamed body, headers and
 * status are what a phone browser would actually get.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { apply, DOWNLOAD_PATH, resolveDownloadTarget } from "../lib/mobile-ux.js";

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "presented-download-"));
	await mkdir(join(root, "sub"));
	await writeFile(join(root, "report.md"), "# report\n");
	await writeFile(join(root, "sub", "data.json"), "{\"ok\":true}");
	await writeFile(join(tmpdir(), "presented-outside-secret.txt"), "secret").catch(() => {});
	const outside = join(tmpdir(), "presented-outside-secret.txt");
	await writeFile(outside, "secret");
	await symlink(outside, join(root, "escape.txt")).catch(() => {});
	const sessions = {
		get: (id) => (id === "session-1" ? { header: { cwd: root } } : undefined),
	};
	return { root, sessions, outside };
}

function mount({ sessions, rejection } = {}) {
	const routes = new Map();
	const webServer = {
		tapIndex: () => () => {},
		register(route) {
			routes.set(route.path, route);
			return () => routes.delete(route.path);
		},
	};
	const connection = { requestRejection: () => rejection };
	const ctx = {
		on() {},
		inject(dependencies, callback) {
			if (dependencies.includes("sessions")) callback({ webServer, connection, sessions });
			else callback({ webServer, connection });
		},
	};
	apply(ctx, {});
	return routes.get(DOWNLOAD_PATH);
}

async function serve(route, url, method = "GET") {
	const server = createServer((req, res) => route.handler(req, res));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const { port } = server.address();
		return await fetch(`http://127.0.0.1:${port}${url}`, { method });
	} finally {
		server.close();
	}
}

test("download serves a workspace file as an attachment", async () => {
	const { sessions } = await fixture();
	const route = mount({ sessions });
	const res = await serve(route, `${DOWNLOAD_PATH}?sessionId=session-1&path=report.md`);
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-type"), "text/markdown");
	assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="report\.md"/);
	assert.equal(await res.text(), "# report\n");
});

test("download accepts absolute paths inside the workspace", async () => {
	const { root, sessions } = await fixture();
	const route = mount({ sessions });
	const res = await serve(route, `${DOWNLOAD_PATH}?sessionId=session-1&path=${encodeURIComponent(join(root, "sub", "data.json"))}`);
	assert.equal(res.status, 200);
	assert.equal(await res.text(), "{\"ok\":true}");
});

test("download refuses escapes, symlinks, directories and unknown sessions", async () => {
	const { root, sessions, outside } = await fixture();
	const route = mount({ sessions });
	const attempts = [
		`${DOWNLOAD_PATH}?sessionId=session-1&path=${encodeURIComponent(outside)}`,
		`${DOWNLOAD_PATH}?sessionId=session-1&path=escape.txt`,
		`${DOWNLOAD_PATH}?sessionId=session-1&path=sub`,
		`${DOWNLOAD_PATH}?sessionId=session-1&path=missing.md`,
		`${DOWNLOAD_PATH}?sessionId=nope&path=report.md`,
		`${DOWNLOAD_PATH}?sessionId=session-1`,
	];
	for (const url of attempts) {
		const res = await serve(route, url);
		assert.equal(res.status, 404, url);
		assert.doesNotMatch(await res.text(), /secret/);
	}
	assert.equal(await resolveDownloadTarget(sessions, "session-1", join(root, "report.md")) !== null, true);
});

test("download answers auth rejections and refuses writes", async () => {
	const { sessions } = await fixture();
	const denied = mount({ sessions, rejection: 403 });
	const res = await serve(denied, `${DOWNLOAD_PATH}?sessionId=session-1&path=report.md`);
	assert.equal(res.status, 403);

	const route = mount({ sessions });
	const posted = await serve(route, `${DOWNLOAD_PATH}?sessionId=session-1&path=report.md`, "POST");
	assert.equal(posted.status, 405);
});

test("HEAD returns the headers without a body", async () => {
	const { sessions } = await fixture();
	const route = mount({ sessions });
	const res = await serve(route, `${DOWNLOAD_PATH}?sessionId=session-1&path=report.md`, "HEAD");
	assert.equal(res.status, 200);
	assert.equal(res.headers.get("content-length"), "9");
	assert.equal(await res.text(), "");
});

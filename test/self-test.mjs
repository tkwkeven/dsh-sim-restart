// Self-test: load the plugin with a mock ctx and verify tool registration
// plus the bundled engine file.
import { apply, name, inject } from "../lib/index.js";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const enginePath = join(__dirname, "..", "lib", "engine.mjs");

const registered = [];
const disposers = [];
const logs = [];

const ctx = {
	logger: {
		info(...args) {
			logs.push(["info", ...args]);
		},
		warn(...args) {
			logs.push(["warn", ...args]);
		},
	},
	shell: {
		resolve(opts) {
			return opts;
		},
		async run() {
			return { stdout: { text: "" }, stderr: { text: "" }, code: 0 };
		},
	},
	fs: {
		async resolve(p) {
			return p;
		},
		async readText(p) {
			return readFileSync(p, "utf8");
		},
		async writeText() {
			return true;
		},
	},
	tools: {
		register(def) {
			registered.push(def);
		},
	},
	timer: {
		timeout() {
			return () => {};
		},
		interval() {
			return () => {};
		},
	},
	systemPrompt: {
		section() {
			return () => {};
		},
	},
	effect(fn) {
		const disposer = fn();
		if (typeof disposer === "function") disposers.push(disposer);
	},
	get(name) {
		if (name === "tools") return ctx.tools;
		return void 0;
	},
};

let failures = 0;
function check(label, cond, detail = "") {
	if (cond) console.log(`  ✅ ${label}`);
	else {
		failures += 1;
		console.error(`  ❌ ${label}${detail ? `\n     ${detail}` : ""}`);
	}
}

console.log(`plugin name: ${name}`);
console.log(`inject: ${inject.join(", ")}`);
check("name is dsh-sim-restart", name === "dsh-sim-restart");
check("inject declares shell", inject.includes("shell"));
check("inject declares fs", inject.includes("fs"));
check("inject declares timer", inject.includes("timer"));
check("inject declares systemPrompt", inject.includes("systemPrompt"));

// Bundled engine must exist and be syntactically valid.
check("bundled engine exists (lib/engine.mjs)", existsSync(enginePath));
if (existsSync(enginePath)) {
	const src = readFileSync(enginePath, "utf8");
	check("engine is non-empty", src.length > 1000, `length=${src.length}`);
	check("engine declares no external imports", !/from ['"][^'"]+['"]/.test(src) || /from ['"]node:/g.test(src));
	const engineCheck = spawnSync(process.execPath, ["--check", enginePath], { encoding: "utf8" });
	check("engine passes node --check", engineCheck.status === 0, engineCheck.stderr);
}

// apply with watcher disabled (self-test must not run real engine rounds).
await apply(ctx, { watchEnabled: false });
check("three tools registered", registered.length === 3, `got ${registered.length}`);

const byName = Object.fromEntries(registered.map((t) => [t.name, t]));
check("simulate_plugin_restart registered", !!byName.simulate_plugin_restart);
check("simulate_plugin_restart_auto registered", !!byName.simulate_plugin_restart_auto);
check("sim_restart_auto_status registered", !!byName.sim_restart_auto_status);

for (const tool of registered) {
	check(
		`${tool.name} has description`,
		typeof tool.description === "string" && tool.description.length > 20,
	);
	check(
		`${tool.name} declares parameters`,
		!!tool.parameters && typeof tool.parameters === "object",
	);
	check(
		`${tool.name} has execute`,
		typeof tool.execute === "function",
	);
	check(
		`${tool.name} has output render`,
		!!tool.output && typeof tool.output.render === "function",
	);
}

check("effect disposers wired (3 tools + 1 report cleanup)", disposers.length === 4, `got ${disposers.length}`);
check("startup log emitted", logs.some((l) => l[0] === "info" && String(l[1]).includes("v0.3.0")), JSON.stringify(logs));

if (failures > 0) {
	console.error(`\n${failures} check(s) FAILED`);
	process.exit(1);
}
console.log("\nAll checks passed ✅");

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, posix, relative, resolve } from "node:path";

/**
 * The shape of src/, asserted rather than assumed.
 *
 * Two import cycles sat in this project unnoticed until an audit went looking
 * (#312), and only `import type` kept them from mattering: the moment one of
 * those edges needed a value, the cycle would have become real without anyone
 * touching the architecture. Reading the graph takes milliseconds, so there is
 * no reason for the next one to go unnoticed either.
 */

// Resolved from the working directory, which vitest sets to the repo root;
// `__dirname` is not defined under the browser globals the lint config uses.
const ROOT = resolve("src");

function sources(dir: string, found: string[] = []): string[] {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) sources(path, found);
		else if (entry.name.endsWith(".ts")) found.push(path);
	}
	return found;
}

/** Every module in src/, by the name its neighbours import it as. */
function graph(): Map<string, string[]> {
	const modules = new Map<string, string>();
	for (const path of sources(ROOT)) {
		modules.set(relative(ROOT, path).replace(/\.ts$/, "").split(/[\\/]/).join("/"), path);
	}
	const edges = new Map<string, string[]>();
	for (const [name, path] of modules) {
		const from = posix.dirname(name);
		const imports: string[] = [];
		// Both forms, because a type-only import is exactly what hid the cycles.
		for (const match of readFileSync(path, "utf8").matchAll(/from "(\.[^"]+)"/g)) {
			const target = posix.normalize(posix.join(from, match[1]));
			if (modules.has(target)) imports.push(target);
		}
		edges.set(name, imports);
	}
	return edges;
}

function cycles(edges: Map<string, string[]>): string[][] {
	const found: string[][] = [];
	const seen = new Set<string>();
	const walk = (node: string, path: string[]): void => {
		for (const next of edges.get(node) ?? []) {
			const at = path.indexOf(next);
			if (at !== -1) found.push([...path.slice(at), next]);
			else if (!seen.has(next)) {
				seen.add(next);
				walk(next, [...path, next]);
			}
		}
	};
	for (const node of edges.keys()) {
		seen.add(node);
		walk(node, [node]);
	}
	return found;
}

describe("the module graph", () => {
	it("has no import cycles", () => {
		// Named in the message, because "expected 1 to be 0" would send the next
		// reader looking for which two files rather than telling them.
		expect(cycles(graph()).map((c) => c.join(" -> "))).toEqual([]);
	});

	it("keeps types.ts downstream of nothing", () => {
		// It imported src/ui/panel-filter, which put the domain's own types
		// downstream of the interface and closed both cycles (#312).
		expect(graph().get("types")).toEqual([]);
	});

	it("keeps the thread domain out of src/ui", () => {
		// Thread and buildThreads are imported by main, navigation and both
		// reading modules. A module four non-UI callers depend on is not UI.
		const edges = graph();
		expect(edges.has("threads")).toBe(true);
		expect(edges.has("ui/threads")).toBe(false);
	});
});

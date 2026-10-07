import { describe, it, expect, vi, afterEach } from "vitest";
import process from "node:process";
import { inBackground } from "../../src/background";

describe("inBackground", () => {
	afterEach(() => vi.restoreAllMocks());

	it("says what failed, and what was being attempted", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const boom = new Error("disk gone");
		inBackground("open a thread from its marker", Promise.reject(boom));
		await vi.waitFor(() => expect(logged).toHaveBeenCalled());
		expect(logged).toHaveBeenCalledWith(
			"margin-comments: could not open a thread from its marker",
			boom,
		);
	});

	it("says nothing when the work succeeds", async () => {
		const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
		inBackground("refresh", Promise.resolve("fine"));
		await Promise.resolve();
		await Promise.resolve();
		expect(logged).not.toHaveBeenCalled();
	});

	it("does not let the rejection escape", async () => {
		// The point of the helper: an unhandled rejection is what this replaces,
		// so it must not produce one itself.
		const unhandled = vi.fn();
		process.on("unhandledRejection", unhandled);
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		inBackground("refresh", Promise.reject(new Error("boom")));
		await new Promise((resolve) => setTimeout(resolve, 20));
		process.off("unhandledRejection", unhandled);
		expect(unhandled).not.toHaveBeenCalled();
	});
});

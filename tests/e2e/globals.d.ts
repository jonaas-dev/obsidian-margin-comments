// Obsidian exposes its App instance on window at runtime but does not declare it.
// E2E code evaluates inside that page, so the tests need the declaration.
declare global {
	interface Window {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		app: any;
		/** Counter a test installs to prove the panel is not re-reading storage. */
		__reads: number;
	}
}

declare module "./launch.mjs" {
	export function launchObsidian(vaultPath: string): Promise<{
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		page: any;
		close(): Promise<void>;
	}>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	export function waitForWorkspace(page: any, timeout?: number): Promise<void>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	export function enablePlugin(page: any, id: string, timeout?: number): Promise<void>;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	export function dismissModals(page: any): Promise<void>;
	export function createTempVault(seed?: Record<string, string>): {
		path: string;
		remove(): void;
	};
}

export {};

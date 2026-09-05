// FNV-1a, two 32-bit passes with different offset bases concatenated into 16 hex
// characters.
//
// Not a cryptographic hash on purpose. This only derives sidecar file names and
// speeds up text lookup, and the plugin must run on mobile: crypto.subtle.digest
// is async, and require('crypto') does not exist there at all. Math.imul keeps the
// multiply in 32-bit range, which plain * would not.
const FNV_PRIME = 16777619;
const OFFSET_BASIS_A = 2166136261;
const OFFSET_BASIS_B = 2166136830;

function fnv1a(input: string, basis: number): number {
	let hash = basis;
	for (let i = 0; i < input.length; i++) {
		const code = input.charCodeAt(i);
		// Feed both bytes of the code unit so characters above U+00FF do not
		// collapse onto their low byte.
		hash = Math.imul(hash ^ (code & 0xff), FNV_PRIME);
		hash = Math.imul(hash ^ (code >>> 8), FNV_PRIME);
	}
	return hash >>> 0;
}

function toHex8(value: number): string {
	return value.toString(16).padStart(8, "0");
}

/** Stable 16-character hex digest of a string. Synchronous and platform-independent. */
export function hashString(input: string): string {
	return toHex8(fnv1a(input, OFFSET_BASIS_A)) + toHex8(fnv1a(input, OFFSET_BASIS_B));
}

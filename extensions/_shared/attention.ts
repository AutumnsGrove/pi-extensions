/**
 * Who knows that `pi-attention` is loaded.
 *
 * `sounds` has to decide before a turn settles whether it still owns the
 * "finished" cue, and `pi-attention` may load after it. A global flag plus a
 * ready event is the same load-order-independent handshake the hooks engine
 * uses; the flag is what `sounds` reads at playback time, the event is what
 * flips it if `pi-attention` loads second.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ATTENTION_READY_CHANNEL = "pi-attention:ready";

const FLAG = "__piAttentionActive";

const holder = globalThis as typeof globalThis & { [FLAG]?: boolean };

/** Announce that attention owns the settle cue for this process. */
export function announceAttention(pi: ExtensionAPI): void {
	holder[FLAG] = true;
	try {
		pi.events.emit(ATTENTION_READY_CHANNEL, {});
	} catch {
		// An announcement is not worth failing a load.
	}
}

/** Withdraw it, so a disabled or unloaded extension leaves sounds alone. */
export function retractAttention(): void {
	holder[FLAG] = false;
}

export function attentionActive(): boolean {
	return holder[FLAG] === true;
}

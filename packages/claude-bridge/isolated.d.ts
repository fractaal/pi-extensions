import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface ClaudeBridgeExtensionOptions {
	userDir?: string;
}

export declare function createClaudeBridgeExtension(options?: ClaudeBridgeExtensionOptions): (pi: ExtensionAPI) => void;
declare const extension: (pi: ExtensionAPI) => void;
export default extension;

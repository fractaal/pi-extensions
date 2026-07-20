export function emitToSubscribers<T>(
	listeners: Iterable<(value: T) => void>,
	value: T,
	source: string,
): void {
	for (const listener of listeners) {
		try {
			listener(value);
		} catch (error) {
			console.error(`[pi-agentic-processes] ${source} subscriber failed`, error);
		}
	}
}

type Subscriber<T> = (value: T) => void | Promise<void>;

function reportSubscriberError(source: string, error: unknown): void {
	console.error(`[pi-agentic-processes] ${source} subscriber failed`, error);
}

export function emitToSubscribers<T>(listeners: Iterable<Subscriber<T>>, value: T, source: string): void {
	for (const listener of listeners) {
		try {
			void Promise.resolve(listener(value)).catch((error) => reportSubscriberError(source, error));
		} catch (error) {
			reportSubscriberError(source, error);
		}
	}
}

type Subscriber<T> = (value: T) => void | Promise<void>;

function reportSubscriberError(source: string, error: unknown): void {
	let detail = "unknown error";
	try {
		detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
	} catch {
		detail = "unprintable error";
	}
	const message = `[pi-agentic-processes] ${source} subscriber failed: ${detail}`;
	try {
		console.error(message);
	} catch {
		try {
			process.stderr.write(`${message}\n`);
		} catch {
			// Observer error reporting must never affect process ownership.
		}
	}
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

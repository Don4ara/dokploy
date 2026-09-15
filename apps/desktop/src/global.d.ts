export {};

declare global {
	interface Window {
		dokployDesktop: {
			getBackend(): Promise<string>;
			installServer(
				input: ServerInstallInput,
			): Promise<{ backend: string; publicKey: string }>;
			onInstallLog(listener: (message: string) => void): () => void;
			probeServer(input: ServerCredentials): Promise<ServerProbe>;
			setBackend(url: string): Promise<string>;
			openExternal(url: string): Promise<void>;
		};
	}

	type ServerCredentials = {
		host: string;
		port: number;
		password: string;
	};

	type ServerInstallInput = ServerCredentials & {
		expectedFingerprint: string;
		image: string;
	};

	type ServerProbe = {
		fingerprint: string;
		platform: string;
	};
}

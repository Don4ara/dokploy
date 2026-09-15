export type ServerCredentials = {
	host: string;
	port: number;
	password: string;
};

export type ServerInstallInput = ServerCredentials & {
	expectedFingerprint: string;
	image: string;
};

export function validateServerCredentials(value: unknown): ServerCredentials {
	if (!value || typeof value !== "object") {
		throw new Error("Invalid server credentials");
	}
	const input = value as Partial<ServerCredentials>;
	const host = input.host?.trim();
	if (!host || host.length > 253 || !/^[a-zA-Z0-9.:[\]-]+$/.test(host)) {
		throw new Error("Enter a valid IP address or hostname");
	}
	if (
		!Number.isInteger(input.port) ||
		Number(input.port) < 1 ||
		Number(input.port) > 65535
	) {
		throw new Error("SSH port must be between 1 and 65535");
	}
	if (!input.password) throw new Error("Root password is required");
	return {
		host: host.replace(/^\[|\]$/g, ""),
		port: Number(input.port),
		password: input.password,
	};
}

export function validateInstallInput(value: unknown): ServerInstallInput {
	const raw = value as Partial<ServerInstallInput>;
	const input = {
		...validateServerCredentials(value),
		expectedFingerprint: raw.expectedFingerprint ?? "",
		image: raw.image?.trim() ?? "",
	};
	if (!/^SHA256:[a-fA-F0-9]+$/.test(input.expectedFingerprint)) {
		throw new Error("Confirm the SSH host fingerprint before installation");
	}
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,255}$/.test(input.image)) {
		throw new Error("Invalid backend image reference");
	}
	return input;
}

export function backendOrigin(host: string) {
	return `http://${host.includes(":") ? `[${host}]` : host}:3000`;
}

export function remoteCommandError(code: number | null, output: string) {
	const detail = output
		.trim()
		.split(/\r?\n/)
		.slice(-20)
		.join("\n")
		.slice(-4_000);
	return `Remote command failed with exit code ${code ?? "unknown"}${detail ? `:\n\n${detail}` : ""}`;
}

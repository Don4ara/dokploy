import { type FormEvent, useEffect, useState } from "react";

type Props = {
	onInstalled(backend: string): Promise<void>;
};

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export function ServerInstaller({ onInstalled }: Props) {
	const [host, setHost] = useState("");
	const [port, setPort] = useState(22);
	const [password, setPassword] = useState("");
	const [image, setImage] = useState(
		import.meta.env.VITE_DOKPLOY_BACKEND_IMAGE ??
			"ghcr.io/don4ara/dokploy-backend:latest",
	);
	const [probe, setProbe] = useState<ServerProbe | null>(null);
	const [confirmed, setConfirmed] = useState(false);
	const [logs, setLogs] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");

	useEffect(
		() =>
			window.dokployDesktop.onInstallLog((message) =>
				setLogs((current) => `${current}${message}`),
			),
		[],
	);

	function credentials() {
		return { host, port, password };
	}

	async function inspect(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		setError("");
		setProbe(null);
		setConfirmed(false);
		try {
			setProbe(await window.dokployDesktop.probeServer(credentials()));
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setBusy(false);
		}
	}

	async function install() {
		if (!probe || !confirmed) return;
		setBusy(true);
		setError("");
		setLogs("");
		try {
			const result = await window.dokployDesktop.installServer({
				...credentials(),
				expectedFingerprint: probe.fingerprint,
				image,
			});
			setPassword("");
			await onInstalled(result.backend);
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setBusy(false);
		}
	}

	return (
		<form className="panel auth installer" onSubmit={inspect}>
			<p className="eyebrow">New server</p>
			<h1>Install backend</h1>
			<p className="muted">
				Fresh Linux server reachable over SSH, with ports 80, 443 and 3000 free.
				The root password is used once and is never saved.
			</p>
			<div className="host-row">
				<label>
					IP address or hostname
					<input
						value={host}
						onChange={(event) => setHost(event.target.value)}
						placeholder="203.0.113.10"
						required
					/>
				</label>
				<label>
					SSH port
					<input
						value={port}
						onChange={(event) => setPort(Number(event.target.value))}
						type="number"
						min="1"
						max="65535"
						required
					/>
				</label>
			</div>
			<label>
				Root password
				<input
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					type="password"
					autoComplete="current-password"
					required
				/>
			</label>
			<label>
				Backend image URL
				<input
					value={image}
					onChange={(event) => setImage(event.target.value)}
					placeholder="ghcr.io/owner/dokploy-backend:latest"
					required
				/>
				<small>
					The remote server pulls this exact image from its registry.
				</small>
			</label>
			<button disabled={busy} type="submit">
				{busy && !probe ? "Checking…" : "Check SSH server"}
			</button>
			{probe && (
				<div className="fingerprint">
					<strong>Verify server identity</strong>
					<pre>{probe.platform}</pre>
					<code>{probe.fingerprint}</code>
					<label className="check">
						<input
							type="checkbox"
							checked={confirmed}
							onChange={(event) => setConfirmed(event.target.checked)}
						/>{" "}
						This fingerprint belongs to my server
					</label>
					<button
						disabled={busy || !confirmed}
						type="button"
						onClick={() => void install()}
					>
						{busy ? "Installing…" : "Install SSH key and backend"}
					</button>
				</div>
			)}
			{error && <p className="error">{error}</p>}
			{logs && <pre className="install-logs">{logs}</pre>}
		</form>
	);
}

import {
	type FormEvent,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import {
	type AuthSession,
	api,
	authClient,
	type Project,
	type ServiceDetails,
	type ServiceRef,
} from "./api";
import { ServerInstaller } from "./ServerInstaller";

type Action = "deploy" | "redeploy" | "start" | "stop";

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

export function App() {
	const [backend, setBackend] = useState("http://localhost:3000");
	const [connected, setConnected] = useState(false);
	const [session, setSession] = useState<AuthSession | null>(null);
	const [projects, setProjects] = useState<Project[]>([]);
	const [selected, setSelected] = useState<ServiceRef | null>(null);
	const [details, setDetails] = useState<ServiceDetails | null>(null);
	const [environment, setEnvironment] = useState("");
	const [logs, setLogs] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	const checkConnection = useCallback(async () => {
		setError("");
		const response = await fetch("/api/health");
		if (!response.ok)
			throw new Error(`Dokploy health check returned ${response.status}`);
		setConnected(true);
		setSession(await authClient.getSession());
	}, []);

	const loadProjects = useCallback(async () => {
		const data = await api.project.all.query();
		setProjects(data);
	}, []);

	useEffect(() => {
		void window.dokployDesktop
			.getBackend()
			.then((value) => {
				setBackend(value);
				return checkConnection();
			})
			.catch((reason) => setError(errorMessage(reason)));
	}, [checkConnection]);

	useEffect(() => {
		if (session)
			void loadProjects().catch((reason) => setError(errorMessage(reason)));
	}, [loadProjects, session]);

	async function connect(event: FormEvent) {
		event.preventDefault();
		setBusy(true);
		try {
			const value = await window.dokployDesktop.setBackend(backend);
			setBackend(value);
			await checkConnection();
		} catch (reason) {
			setConnected(false);
			setError(errorMessage(reason));
		} finally {
			setBusy(false);
		}
	}

	async function finishInstallation(url: string) {
		setBackend(url);
		await window.dokployDesktop.setBackend(url);
		let lastError: unknown;
		for (let attempt = 0; attempt < 40; attempt += 1) {
			try {
				await checkConnection();
				return;
			} catch (reason) {
				lastError = reason;
				await new Promise((resolve) => setTimeout(resolve, 3_000));
			}
		}
		throw lastError ?? new Error("Dokploy backend did not become ready");
	}

	async function signIn(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setBusy(true);
		setError("");
		const form = new FormData(event.currentTarget);
		try {
			await authClient.signIn(
				String(form.get("email")),
				String(form.get("password")),
			);
			setSession(await authClient.getSession());
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setBusy(false);
		}
	}

	async function signOut() {
		await authClient.signOut();
		setSession(null);
		setProjects([]);
		setSelected(null);
	}

	async function selectService(service: ServiceRef) {
		setSelected(service);
		setLogs("");
		setError("");
		try {
			const data =
				service.kind === "application"
					? await api.application.one.query({ applicationId: service.id })
					: await api.compose.one.query({ composeId: service.id });
			const value = data as ServiceDetails;
			setDetails(value);
			setEnvironment(value.env ?? "");
		} catch (reason) {
			setError(errorMessage(reason));
		}
	}

	async function runAction(action: Action) {
		if (!selected) return;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			if (selected.kind === "application") {
				await api.application[action].mutate({ applicationId: selected.id });
			} else {
				await api.compose[action].mutate({ composeId: selected.id });
			}
			setNotice(`${action} accepted for ${selected.name}`);
			await loadProjects();
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setBusy(false);
		}
	}

	async function saveEnvironment() {
		if (!selected || !details) return;
		setBusy(true);
		setError("");
		try {
			if (selected.kind === "application") {
				await api.application.saveEnvironment.mutate({
					applicationId: selected.id,
					env: environment,
					buildArgs: details.buildArgs ?? "",
					buildSecrets: details.buildSecrets ?? "",
					createEnvFile: Boolean(details.createEnvFile),
				});
			} else {
				await api.compose.saveEnvironment.mutate({
					composeId: selected.id,
					env: environment,
					createEnvFile: Boolean(details.createEnvFile),
				});
			}
			setNotice("Environment variables saved");
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setBusy(false);
		}
	}

	async function loadLogs() {
		if (selected?.kind !== "application") return;
		setBusy(true);
		setError("");
		try {
			const value = await api.application.readLogs.query({
				applicationId: selected.id,
				tail: 300,
				since: "all",
			});
			setLogs(
				typeof value === "string" ? value : JSON.stringify(value, null, 2),
			);
		} catch (reason) {
			setError(errorMessage(reason));
		} finally {
			setBusy(false);
		}
	}

	const services = useMemo(
		() =>
			projects.flatMap((project) =>
				project.environments.flatMap((environmentItem) => [
					...environmentItem.applications.map((item) => ({
						id: item.applicationId,
						kind: "application" as const,
						name: item.name,
						status: item.applicationStatus,
					})),
					...environmentItem.compose.map((item) => ({
						id: item.composeId,
						kind: "compose" as const,
						name: item.name,
						status: item.composeStatus,
					})),
				]),
			),
		[projects],
	);

	if (!connected) {
		return (
			<main className="centered onboarding">
				<div className="onboarding-grid">
					<form className="panel auth" onSubmit={connect}>
						<p className="eyebrow">Existing server</p>
						<h1>Connect backend</h1>
						<p className="muted">
							Use the public origin of an existing Dokploy backend.
						</p>
						<label>
							Server URL
							<input
								value={backend}
								onChange={(event) => setBackend(event.target.value)}
								placeholder="https://dokploy.example.com"
							/>
						</label>
						{error && <p className="error">{error}</p>}
						<button disabled={busy} type="submit">
							{busy ? "Connecting…" : "Connect"}
						</button>
					</form>
					<ServerInstaller onInstalled={finishInstallation} />
				</div>
			</main>
		);
	}

	if (!session) {
		return (
			<main className="centered">
				<form className="panel auth" onSubmit={signIn}>
					<p className="eyebrow">{backend}</p>
					<h1>Sign in</h1>
					<label>
						Email
						<input name="email" type="email" autoComplete="email" required />
					</label>
					<label>
						Password
						<input
							name="password"
							type="password"
							autoComplete="current-password"
							required
						/>
					</label>
					{error && <p className="error">{error}</p>}
					<button disabled={busy} type="submit">
						{busy ? "Signing in…" : "Sign in"}
					</button>
					<button
						className="ghost"
						type="button"
						onClick={() => setConnected(false)}
					>
						Change server
					</button>
				</form>
			</main>
		);
	}

	return (
		<div className="shell">
			<header>
				<div>
					<strong>Dokploy</strong>
					<span>Desktop</span>
				</div>
				<nav>
					<small>{backend}</small>
					<small>{session.user.email}</small>
					<button className="ghost" type="button" onClick={signOut}>
						Sign out
					</button>
				</nav>
			</header>
			<aside>
				<div className="aside-title">
					<span>Projects</span>
					<button
						className="icon"
						type="button"
						onClick={() => void loadProjects()}
						aria-label="Refresh"
					>
						↻
					</button>
				</div>
				{projects.map((project) => (
					<section className="project" key={project.projectId}>
						<h2>{project.name}</h2>
						{project.environments.map((environmentItem) => (
							<div key={environmentItem.environmentId}>
								<h3>{environmentItem.name}</h3>
								{services
									.filter((service) =>
										[
											...environmentItem.applications.map(
												(item) => item.applicationId,
											),
											...environmentItem.compose.map((item) => item.composeId),
										].includes(service.id),
									)
									.map((service) => (
										<button
											className={`service ${selected?.id === service.id ? "active" : ""}`}
											type="button"
											key={service.id}
											onClick={() => void selectService(service)}
										>
											<i className={`status ${service.status ?? "idle"}`} />
											<span>{service.name}</span>
											<small>
												{service.kind === "application" ? "App" : "Compose"}
											</small>
										</button>
									))}
							</div>
						))}
					</section>
				))}
			</aside>
			<main className="content">
				{error && <p className="banner error">{error}</p>}
				{notice && <p className="banner notice">{notice}</p>}
				{!selected ? (
					<div className="empty">
						<h1>Select a service</h1>
						<p>
							Projects and services come directly from the existing Dokploy tRPC
							API.
						</p>
					</div>
				) : (
					<>
						<div className="title-row">
							<div>
								<p className="eyebrow">{selected.kind}</p>
								<h1>{selected.name}</h1>
							</div>
							<span className="pill">{selected.status ?? "unknown"}</span>
						</div>
						<div className="actions">
							<button
								disabled={busy}
								type="button"
								onClick={() => void runAction("deploy")}
							>
								Deploy
							</button>
							<button
								disabled={busy}
								type="button"
								onClick={() => void runAction("redeploy")}
							>
								Redeploy
							</button>
							<button
								disabled={busy}
								className="secondary"
								type="button"
								onClick={() => void runAction("start")}
							>
								Start
							</button>
							<button
								disabled={busy}
								className="danger"
								type="button"
								onClick={() => void runAction("stop")}
							>
								Stop
							</button>
						</div>
						<div className="grid">
							<section className="panel editor">
								<div className="section-title">
									<h2>Environment</h2>
									<button
										disabled={busy}
										type="button"
										onClick={() => void saveEnvironment()}
									>
										Save
									</button>
								</div>
								<textarea
									value={environment}
									onChange={(event) => setEnvironment(event.target.value)}
									spellCheck={false}
								/>
							</section>
							<section className="panel">
								<h2>Domains</h2>
								{details?.domains?.length ? (
									<ul className="domains">
										{details.domains.map((domain) => (
											<li key={domain.domainId}>
												<span>
													{domain.https ? "https" : "http"}://{domain.host}
												</span>
												<small>
													{domain.certificateType ?? "no certificate"}
												</small>
											</li>
										))}
									</ul>
								) : (
									<p className="muted">No domains configured.</p>
								)}
							</section>
						</div>
						<section className="panel logs">
							<div className="section-title">
								<h2>Logs</h2>
								{selected.kind === "application" ? (
									<button
										disabled={busy}
										type="button"
										onClick={() => void loadLogs()}
									>
										Load last 300 lines
									</button>
								) : (
									<small>Container selection is the next migration slice</small>
								)}
							</div>
							<pre>{logs || "Logs have not been loaded."}</pre>
						</section>
					</>
				)}
			</main>
		</div>
	);
}

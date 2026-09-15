import {
	createReadStream,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import {
	createServer,
	request as httpRequest,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type OutgoingHttpHeaders,
	type ServerResponse,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { connect as netConnect } from "node:net";
import { extname, join, normalize } from "node:path";
import { connect as tlsConnect } from "node:tls";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { Client, type ConnectConfig, utils as sshUtils } from "ssh2";
import type { ViteDevServer } from "vite";
import installBackendScript from "../resources/install-backend.sh";
import {
	backendOrigin,
	remoteCommandError,
	type ServerCredentials,
	validateInstallInput,
	validateServerCredentials,
} from "./install-validation";

const isDevelopment = process.argv.includes("--dev");
const defaultBackend = process.env.DOKPLOY_URL ?? "http://localhost:3000";
const backendSocketPaths = new Set([
	"/drawer-logs",
	"/listen-deployment",
	"/docker-container-logs",
	"/docker-container-terminal",
	"/terminal",
	"/listen-docker-stats-monitoring",
]);

let backend = new URL(defaultBackend);
let localOrigin = "";

function connectSsh(input: ServerCredentials, expectedFingerprint?: string) {
	return new Promise<{ client: Client; fingerprint: string }>(
		(resolve, reject) => {
			const client = new Client();
			let fingerprint = "";
			const config: ConnectConfig = {
				host: input.host,
				port: input.port,
				username: "root",
				password: input.password,
				readyTimeout: 15_000,
				hostHash: "sha256",
				hostVerifier(hash: string) {
					fingerprint = `SHA256:${hash}`;
					return !expectedFingerprint || fingerprint === expectedFingerprint;
				},
			};
			client.once("ready", () => resolve({ client, fingerprint }));
			client.once("error", reject);
			client.connect(config);
		},
	);
}

function connectSshWithKey(
	input: Pick<ServerCredentials, "host" | "port">,
	privateKey: string,
	expectedFingerprint: string,
) {
	return new Promise<Client>((resolve, reject) => {
		const client = new Client();
		client.once("ready", () => resolve(client));
		client.once("error", reject);
		client.connect({
			host: input.host,
			port: input.port,
			username: "root",
			privateKey,
			readyTimeout: 15_000,
			hostHash: "sha256",
			hostVerifier: (hash: string) => `SHA256:${hash}` === expectedFingerprint,
		});
	});
}

function execSsh(
	client: Client,
	command: string,
	onData?: (value: string) => void,
) {
	return new Promise<string>((resolve, reject) => {
		client.exec(command, (error, stream) => {
			if (error) return reject(error);
			let output = "";
			const collect = (chunk: Buffer) => {
				const value = chunk.toString();
				output += value;
				onData?.(value);
			};
			stream.on("data", collect);
			stream.stderr.on("data", collect);
			stream.once("close", (code: number | null) => {
				if (code === 0) resolve(output);
				else reject(new Error(remoteCommandError(code, output)));
			});
		});
	});
}

function getOrCreateServerKey(host: string, port: number) {
	const safeName = `${host}_${port}`.replace(/[^a-zA-Z0-9_.-]/g, "_");
	const directory = join(app.getPath("userData"), "ssh");
	const privatePath = join(directory, safeName);
	const publicPath = `${privatePath}.pub`;
	if (existsSync(privatePath) && existsSync(publicPath)) {
		return {
			privateKey: readFileSync(privatePath, "utf8"),
			publicKey: readFileSync(publicPath, "utf8"),
		};
	}
	const keys = sshUtils.generateKeyPairSync("ed25519", {
		comment: "dokploy-desktop",
	});
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	writeFileSync(privatePath, keys.private, { mode: 0o600 });
	writeFileSync(publicPath, keys.public, { mode: 0o644 });
	return { privateKey: keys.private, publicKey: keys.public };
}

function normalizeBackend(value: string) {
	const url = new URL(value.trim());
	if (!["http:", "https:"].includes(url.protocol)) {
		throw new Error("Dokploy URL must use http:// or https://");
	}
	if (url.username || url.password || url.search || url.hash) {
		throw new Error("Dokploy URL must not contain credentials, query, or hash");
	}
	if (url.pathname !== "/") {
		throw new Error("Dokploy must be configured at the origin root");
	}
	return url;
}

function configPath() {
	return join(app.getPath("userData"), "connection.json");
}

function loadBackend() {
	try {
		const stored = JSON.parse(readFileSync(configPath(), "utf8")) as {
			backend?: string;
		};
		if (stored.backend) backend = normalizeBackend(stored.backend);
	} catch {
		backend = normalizeBackend(defaultBackend);
	}
}

function saveBackend(value: string) {
	backend = normalizeBackend(value);
	writeFileSync(
		configPath(),
		JSON.stringify({ backend: backend.origin }, null, 2),
	);
	return backend.origin;
}

function proxyHeaders(
	headers: IncomingHttpHeaders,
	target: URL,
): OutgoingHttpHeaders {
	const next: OutgoingHttpHeaders = { ...headers, host: target.host };
	if (next.origin) next.origin = target.origin;
	if (next.referer) next.referer = `${target.origin}/`;
	return next;
}

function proxyHttp(req: IncomingMessage, res: ServerResponse) {
	const target = new URL(req.url ?? "/", backend);
	const send = target.protocol === "https:" ? httpsRequest : httpRequest;
	const upstream = send(
		target,
		{
			method: req.method,
			headers: proxyHeaders(req.headers, target),
		},
		(upstreamResponse) => {
			const headers: OutgoingHttpHeaders = { ...upstreamResponse.headers };
			const cookies = upstreamResponse.headers["set-cookie"];
			if (cookies) {
				headers["set-cookie"] = cookies.map((cookie) =>
					cookie.replace(/;\s*domain=[^;]+/gi, ""),
				);
			}
			res.writeHead(upstreamResponse.statusCode ?? 502, headers);
			upstreamResponse.pipe(res);
		},
	);
	upstream.on("error", (error) => {
		if (!(res as { headersSent?: boolean }).headersSent) {
			res.writeHead(502, { "content-type": "application/json" });
		}
		res.end(
			JSON.stringify({ error: `Cannot reach Dokploy: ${error.message}` }),
		);
	});
	req.pipe(upstream);
}

function proxyWebSocket(
	req: IncomingMessage,
	socket: import("node:stream").Duplex,
	head: Buffer,
) {
	const secure = backend.protocol === "https:";
	const port = Number(backend.port || (secure ? 443 : 80));
	const connect = secure
		? () =>
				tlsConnect({
					host: backend.hostname,
					port,
					servername: backend.hostname,
				})
		: () => netConnect({ host: backend.hostname, port });
	const upstream = connect();

	upstream.once("connect", () => {
		const headers = proxyHeaders(req.headers, backend);
		const lines = [
			`${req.method ?? "GET"} ${req.url ?? "/"} HTTP/${req.httpVersion}`,
		];
		for (const [name, value] of Object.entries(headers)) {
			if (value !== undefined)
				lines.push(
					`${name}: ${Array.isArray(value) ? value.join(", ") : value}`,
				);
		}
		upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
		if (head.length) upstream.write(head);
		socket.pipe(upstream).pipe(socket);
	});
	upstream.on("error", () => socket.destroy());
}

const mimeTypes: Record<string, string> = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
};

function serveRenderer(req: IncomingMessage, res: ServerResponse) {
	const root = join(__dirname, "../renderer");
	const pathname = decodeURIComponent(
		new URL(req.url ?? "/", localOrigin).pathname,
	);
	const requested = normalize(join(root, pathname));
	const file =
		requested.startsWith(root) &&
		existsSync(requested) &&
		statSync(requested).isFile()
			? requested
			: join(root, "index.html");
	res.writeHead(200, {
		"content-type": mimeTypes[extname(file)] ?? "application/octet-stream",
		"content-security-policy":
			"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
	});
	createReadStream(file).pipe(res);
}

async function startGateway() {
	let vite: ViteDevServer | undefined;
	if (isDevelopment) {
		const { createServer: createViteServer } = await import("vite");
		vite = await createViteServer({
			root: join(__dirname, "../.."),
			server: { middlewareMode: true, hmr: false },
			appType: "spa",
		});
	}

	const server = createServer((req, res) => {
		if (req.url?.startsWith("/api/")) return proxyHttp(req, res);
		if (vite) return vite.middlewares(req, res);
		serveRenderer(req, res);
	});
	server.on("upgrade", (req, socket, head) => {
		const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
		if (backendSocketPaths.has(pathname))
			return proxyWebSocket(req, socket, head);
		socket.destroy();
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string")
		throw new Error("Desktop gateway failed to start");
	localOrigin = `http://127.0.0.1:${address.port}`;
	return localOrigin;
}

function trustedSender(event: Electron.IpcMainInvokeEvent) {
	return event.senderFrame?.url.startsWith(`${localOrigin}/`) ?? false;
}

async function createWindow() {
	loadBackend();
	const origin = await startGateway();
	const window = new BrowserWindow({
		width: 1360,
		height: 860,
		minWidth: 960,
		minHeight: 640,
		backgroundColor: "#0b1020",
		webPreferences: {
			preload: join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		},
	});

	window.webContents.on("will-navigate", (event, url) => {
		if (!url.startsWith(`${origin}/`)) event.preventDefault();
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (["http:", "https:"].includes(new URL(url).protocol))
			void shell.openExternal(url);
		return { action: "deny" };
	});
	await window.loadURL(origin);
}

ipcMain.handle("backend:get", (event) => {
	if (!trustedSender(event)) throw new Error("Untrusted IPC sender");
	return backend.origin;
});
ipcMain.handle("server:probe", async (event, value: unknown) => {
	if (!trustedSender(event)) throw new Error("Untrusted IPC sender");
	const input = validateServerCredentials(value);
	const { client, fingerprint } = await connectSsh(input);
	try {
		const platform = await execSsh(
			client,
			'uname -srm; if [ -r /etc/os-release ]; then . /etc/os-release; printf \'%s %s\\n\' "$NAME" "$VERSION_ID"; fi',
		);
		return { fingerprint, platform: platform.trim() };
	} finally {
		client.end();
	}
});
ipcMain.handle("server:install", async (event, value: unknown) => {
	if (!trustedSender(event)) throw new Error("Untrusted IPC sender");
	const input = validateInstallInput(value);
	const log = (message: string) =>
		event.sender.send("server:install-log", message);
	const { client } = await connectSsh(input, input.expectedFingerprint);
	try {
		const key = getOrCreateServerKey(input.host, input.port);
		const publicKey = Buffer.from(key.publicKey).toString("base64");
		await execSsh(
			client,
			`umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; key=$(printf '%s' '${publicKey}' | base64 -d); grep -qxF "$key" ~/.ssh/authorized_keys || printf '%s\\n' "$key" >> ~/.ssh/authorized_keys`,
			log,
		);
		log("✓ Dokploy Desktop SSH key installed\n");
		const script = Buffer.from(installBackendScript).toString("base64");
		const image = input.image.replace(/'/g, "'\"'\"'");
		const advertiseAddress = input.host.replace(/'/g, "'\"'\"'");
		await execSsh(
			client,
			`printf '%s' '${script}' | base64 -d | env DOKPLOY_IMAGE='${image}' ADVERTISE_ADDR='${advertiseAddress}' sh`,
			log,
		);
		const keyClient = await connectSshWithKey(
			input,
			key.privateKey,
			input.expectedFingerprint,
		);
		try {
			await execSsh(keyClient, "true");
			log("✓ Passwordless SSH key verified\n");
		} finally {
			keyClient.end();
		}
		await event.sender.session.clearStorageData({ storages: ["cookies"] });
		const origin = saveBackend(backendOrigin(input.host));
		return { backend: origin, publicKey: key.publicKey.trim() };
	} finally {
		client.end();
	}
});
ipcMain.handle("backend:set", async (event, value: unknown) => {
	if (!trustedSender(event) || typeof value !== "string")
		throw new Error("Invalid backend URL");
	await event.sender.session.clearStorageData({ storages: ["cookies"] });
	return saveBackend(value);
});
ipcMain.handle("external:open", async (event, value: unknown) => {
	if (!trustedSender(event) || typeof value !== "string")
		throw new Error("Invalid external URL");
	const url = new URL(value);
	if (!["http:", "https:"].includes(url.protocol))
		throw new Error("Unsupported external URL");
	await shell.openExternal(url.toString());
});

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
	if (BrowserWindow.getAllWindows().length === 0) void createWindow();
});

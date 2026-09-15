import { createTRPCUntypedClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

export type AuthSession = {
	session: { id: string; activeOrganizationId?: string | null };
	user: { id: string; email: string; name: string };
};

async function authRequest<T>(path: string, init?: RequestInit) {
	const response = await fetch(`/api/auth/${path}`, {
		...init,
		credentials: "include",
		headers: { "content-type": "application/json", ...init?.headers },
	});
	const data = await response.json().catch(() => null);
	if (!response.ok) {
		throw new Error(
			data?.message ??
				data?.error ??
				`Authentication failed (${response.status})`,
		);
	}
	return data as T;
}

export const authClient = {
	getSession: () => authRequest<AuthSession | null>("get-session"),
	signUp: (input: {
		email: string;
		password: string;
		name: string;
		lastName: string;
	}) =>
		authRequest<unknown>("sign-up/email", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	signIn: (email: string, password: string) =>
		authRequest<unknown>("sign-in/email", {
			method: "POST",
			body: JSON.stringify({ email, password }),
		}),
	signOut: () =>
		authRequest<unknown>("sign-out", { method: "POST", body: "{}" }),
};

const client = createTRPCUntypedClient({
	links: [
		httpBatchLink({
			url: `${window.location.origin}/api/trpc`,
			transformer: superjson,
			fetch(url, options) {
				return globalThis.fetch(url, { ...options, credentials: "include" });
			},
		}),
	],
});

export type Project = {
	projectId: string;
	name: string;
	environments: Array<{
		environmentId: string;
		name: string;
		applications: Array<{
			applicationId: string;
			name: string;
			applicationStatus: string | null;
		}>;
		compose: Array<{
			composeId: string;
			name: string;
			composeStatus: string | null;
		}>;
	}>;
};

export type ServiceRef = {
	id: string;
	kind: "application" | "compose";
	name: string;
	status: string | null;
};

export type ServiceDetails = {
	appName?: string;
	buildArgs?: string | null;
	buildSecrets?: string | null;
	createEnvFile?: boolean | null;
	domains?: Array<{
		domainId: string;
		host: string;
		https?: boolean | null;
		certificateType?: string | null;
	}>;
	env?: string | null;
};

const query = <T>(path: string, input?: unknown) =>
	client.query(path, input) as Promise<T>;
const mutate = <T = unknown>(path: string, input?: unknown) =>
	client.mutation(path, input) as Promise<T>;

export const api = {
	settings: {
		hasAdmin: { query: () => query<boolean>("settings.hasAdmin") },
	},
	project: {
		all: { query: () => query<Project[]>("project.all") },
	},
	application: {
		one: {
			query: (input: { applicationId: string }) =>
				query<ServiceDetails>("application.one", input),
		},
		deploy: {
			mutate: (input: { applicationId: string }) =>
				mutate("application.deploy", input),
		},
		redeploy: {
			mutate: (input: { applicationId: string }) =>
				mutate("application.redeploy", input),
		},
		start: {
			mutate: (input: { applicationId: string }) =>
				mutate("application.start", input),
		},
		stop: {
			mutate: (input: { applicationId: string }) =>
				mutate("application.stop", input),
		},
		saveEnvironment: {
			mutate: (input: {
				applicationId: string;
				env: string;
				buildArgs: string;
				buildSecrets: string;
				createEnvFile: boolean;
			}) => mutate("application.saveEnvironment", input),
		},
		readLogs: {
			query: (input: { applicationId: string; tail: number; since: string }) =>
				query<unknown>("application.readLogs", input),
		},
	},
	compose: {
		one: {
			query: (input: { composeId: string }) =>
				query<ServiceDetails>("compose.one", input),
		},
		deploy: {
			mutate: (input: { composeId: string }) => mutate("compose.deploy", input),
		},
		redeploy: {
			mutate: (input: { composeId: string }) =>
				mutate("compose.redeploy", input),
		},
		start: {
			mutate: (input: { composeId: string }) => mutate("compose.start", input),
		},
		stop: {
			mutate: (input: { composeId: string }) => mutate("compose.stop", input),
		},
		saveEnvironment: {
			mutate: (input: {
				composeId: string;
				env: string;
				createEnvFile: boolean;
			}) => mutate("compose.saveEnvironment", input),
		},
	},
};

declare module "*.sh" {
	const contents: string;
	export default contents;
}

declare module "*.css";

interface ImportMetaEnv {
	readonly VITE_DOKPLOY_BACKEND_IMAGE?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}

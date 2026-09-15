import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("dokployDesktop", {
	getBackend: (): Promise<string> => ipcRenderer.invoke("backend:get"),
	probeServer: (input: ServerCredentials): Promise<ServerProbe> =>
		ipcRenderer.invoke("server:probe", input),
	installServer: (
		input: ServerInstallInput,
	): Promise<{ backend: string; publicKey: string }> =>
		ipcRenderer.invoke("server:install", input),
	onInstallLog: (listener: (message: string) => void) => {
		const handler = (_event: Electron.IpcRendererEvent, message: string) =>
			listener(message);
		ipcRenderer.on("server:install-log", handler);
		return () => ipcRenderer.removeListener("server:install-log", handler);
	},
	setBackend: (url: string): Promise<string> =>
		ipcRenderer.invoke("backend:set", url),
	openExternal: (url: string): Promise<void> =>
		ipcRenderer.invoke("external:open", url),
});

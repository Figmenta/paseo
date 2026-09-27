import { contextBridge, ipcRenderer } from "electron";

// Figmenta fork: preload of the mandatory-update screen (a local data: page layered over
// the Orchestra window, see mandatory-update-electron.ts). It hands that page the state
// and its two actions — nothing else. Sandboxed and tsc-compiled, so "electron" is the
// only module it may load.
contextBridge.exposeInMainWorld("orchestraUpdate", {
  getState: (): Promise<unknown> => ipcRenderer.invoke("orchestra-update:get-state"),
  onState: (listener: (state: unknown) => void): void => {
    ipcRenderer.on("orchestra-update:state", (_event, state: unknown) => listener(state));
  },
  install: (): void => ipcRenderer.send("orchestra-update:install"),
  retry: (): void => ipcRenderer.send("orchestra-update:retry"),
});

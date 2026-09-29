import { contextBridge, ipcRenderer } from "electron";

// Figmenta fork: preload of the "Setting up Claude Code" window (claude-code-setup-electron.ts).
// It hands that page its state and its one action — nothing else. Sandboxed and tsc-compiled, so
// "electron" is the only module it may load.
contextBridge.exposeInMainWorld("orchestraSetup", {
  getState: (): Promise<unknown> => ipcRenderer.invoke("orchestra-setup:get-state"),
  onState: (listener: (state: unknown) => void): void => {
    ipcRenderer.on("orchestra-setup:state", (_event, state: unknown) => listener(state));
  },
  retry: (): void => ipcRenderer.send("orchestra-setup:retry"),
});

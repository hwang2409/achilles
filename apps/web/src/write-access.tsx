import { createContext, useContext, type ReactNode } from "react";
import type { ConnectionState } from "./zeta";

export const canWrite = (state: ConnectionState) => state.phase === "connected" && state.authority === "controller";

const WriteAccess = createContext(false);

export function WriteAccessProvider({ value, children }: { value: boolean; children: ReactNode }) {
  return <WriteAccess.Provider value={value}>{children}</WriteAccess.Provider>;
}

export const useCanWrite = () => useContext(WriteAccess);

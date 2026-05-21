// Backwards-compat shim. Real auth lives in AuthContext.tsx.
export { AuthProvider as AppProvider, useAuth as useApp } from "./AuthContext";
export type { Role, Theme } from "./AuthContext";

import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

const hasCompleteLocalStorage =
  typeof localStorage !== "undefined" &&
  typeof localStorage.getItem === "function" &&
  typeof localStorage.setItem === "function" &&
  typeof localStorage.removeItem === "function" &&
  typeof localStorage.clear === "function";

if (!hasCompleteLocalStorage) {
  const localStorageData = new Map<string, string>();

  Object.defineProperty(window, "localStorage", {
    value: {
      getItem: (key: string) => localStorageData.get(key) ?? null,
      setItem: (key: string, value: string) => {
        localStorageData.set(key, value);
      },
      removeItem: (key: string) => {
        localStorageData.delete(key);
      },
      clear: () => {
        localStorageData.clear();
      },
    },
    configurable: true,
  });
}

// Unmount React trees after each test so side effects and timers
// don't leak between tests.
afterEach(() => {
  cleanup();
});

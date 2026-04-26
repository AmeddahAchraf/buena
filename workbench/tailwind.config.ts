import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        canvas: "#f5f4f1",
        panel: "#ffffff",
        ink: "#1a1a1a",
        muted: "#6b6b66",
        line: "#e5e3dd",
        accent: "#1a1a1a",
        warn: "#b45309",
        ok: "#0f766e",
        flag: "#9f1239",
      },
      fontFamily: {
        sans: [
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Inter",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "Monaco",
          "Consolas",
          "monospace",
        ],
      },
      boxShadow: {
        panel: "0 1px 0 0 rgba(0,0,0,0.02), 0 0 0 1px rgba(0,0,0,0.04)",
      },
    },
  },
  plugins: [],
};

export default config;

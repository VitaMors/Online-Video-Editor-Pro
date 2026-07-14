import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      colors: {
        editor: {
          shell: "#0d1117",
          panel: "#151b23",
          panel2: "#1b2330",
          line: "#2b3545",
          ink: "#e6edf3",
          muted: "#8b949e",
          cyan: "#39d0c8",
          amber: "#f2b84b",
          rose: "#ff6b8a",
          violet: "#9b8cff",
        },
      },
    },
  },
  plugins: [],
} satisfies Config;

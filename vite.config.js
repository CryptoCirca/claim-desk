import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base: "./" makes the build work at any URL, including
// GitHub Pages project URLs like username.github.io/repo-name/
export default defineConfig({ base: "./", plugins: [react()] });

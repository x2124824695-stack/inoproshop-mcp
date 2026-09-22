import {defineConfig} from 'vitest/config';
export default defineConfig({cacheDir: process.env.TEMP + '/inoproshop-mcp-vite-cache', test:{include:['tests/**/*.test.ts'],pool:'forks',poolOptions:{forks:{singleFork:true}},testTimeout:15000}});

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'

export default tseslint.config(
  {
    // `.dev-flow/**` 是别的工作树落在仓库里的构建产物（out/main、out/preload …），
    // 不 ignore 就会让 `eslint .` 永久报上千条错误，提交钩子只能靠 --no-verify 绕过。
    ignores: [
      'out',
      'dist',
      'node_modules',
      '.tmp/**',
      'resources/**',
      'data/**',
      'logs/**',
      '.pi/**',
      '.dev-flow/**',
      // `.worktrees/**` 同理：别人注册在仓库里的 git worktree（含 CJS 脚本），
      // 不 ignore 会把别人工作区的源码扫进 `eslint .`，钩子对所有人都是坏的。
      '.worktrees/**'
    ]
  },
  {
    files: ['**/*.config.js'],
    languageOptions: {
      globals: {
        module: 'readonly'
      }
    }
  },
  {
    // Node 脚本（基准/工具）跑在 Node 里，不在 eslint 的默认 globals 里
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly'
      }
    }
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/renderer/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'warn'
    }
  }
)

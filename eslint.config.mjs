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
  {
    // 探针的退出码就是它的结论：`app.exit(0)` 无论成败都退 0，失败看起来和全通过一样
    // （这正是「探针静默退 0」那类假绿灯的来源）。要退就调 harness 的 exitProbe / finishProbe，
    // 由它统一判「有没有断言跑过」再决定退出码；harness 自己是唯一允许碰 app.exit 的地方。
    files: ['src/main/probes/**/*.ts'],
    ignores: ['src/main/probes/harness.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'app', property: 'exit', message: '探针用 harness 的 exitProbe/finishProbe，别自己 app.exit' },
        { object: 'process', property: 'exit', message: '探针用 harness 的 exitProbe/finishProbe，别自己 process.exit' }
      ]
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

# dev-flow

<!-- Operator-owned playbook. Regenerate with: flow init --draft -->

## global

```flow
defaultBranch = main
forge = github
```

## plan

- [ ] rendered mockups attached for every changed screen

<!-- what the plan must contain, UI expectations -->

## implement

```flow
setup = npm install
build = npm run build
```

```flow-check typecheck
npx tsc --noEmit -p tsconfig.node.json --composite false
npx tsc --noEmit -p tsconfig.web.json --composite false
```

```flow-check lint
npx eslint .
```

- [ ] app runs locally with real data; visual pass: no overflows or stray scrollbars

<!-- Desktop Electron app: run with npm run dev (renderer hot-reloads; main-process changes need a restart). No health endpoint - pre-release verification uses the --xxx-probe binaries. -->

## pre-release

<!-- review policy: /flow-review before Release?; manual probe pass is the operator's call -->

```flow
versionFile = package.json
versionTag = v{version}
```

## release

<!-- artifacts: NSIS installer + portable zip to GitHub Releases via release.yml; nothing pushed to a registry -->

```flow
merge = squash
releases = yes
```

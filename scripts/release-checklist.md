# Release Checklist — ucu-mcp

Run this checklist before every `npm publish`. Each step has a one-line command
and a one-line "success criterion" so the publisher can verify completion.

## Pre-publish

1. **Build native helpers + bundle TS**
   - Command: `npm run build`
   - Success: `dist/bin/ucu-mcp.js`, `dist/native/cgevent/cgevent-helper`, and
     `dist/native/ocr/ocr-helper` all exist; no TS errors.

2. **Run full test suite**
   - Command: `ECC_GATEGUARD=off npx vitest run`
   - Success: `0 failed`, all non-skipped tests pass. Confirm the count of
     `skipped` matches the expected skipped tests (e.g. UCU_CLIENT_CLI_SMOKE
     gated tests).

3. **Inspect the npm tarball**
   - Command: `npm pack --dry-run`
   - Success: tarball contains `package.json`, `dist/`, `README.md`,
     `LICENSE`, but does NOT contain `src/`, `tests/`, `.codex/`,
     `.claude/`, `node_modules/`, or `.env`.

4. **Working tree is clean**
   - Command: `git status`
   - Success: `nothing to commit, working tree clean`. No untracked local
     files that should have been committed or gitignored.

## Publish

5. **Bump version + publish**
   - Command: `npm version <patch|minor|major>` then `npm publish`
   - Success: `npm publish` exits 0; new version visible in the output of
     `npm view ucu-mcp version`.

6. **Verify registry**
   - Command: `npm view ucu-mcp version`
   - Success: returns the version you just published.

7. **Smoke the published package**
   - Command: `npx ucu-mcp@latest doctor`
   - Success: doctor JSON prints, includes `readiness`, `safety`,
     `clients.claude`, `clients.codex`, etc. with expected values.

## Post-publish

8. **Push tags + commits**
   - Command: `git push && git push --tags`
   - Success: origin/main and origin tag are both ahead by 1.

9. **Sync progress to Obsidian**
   - Location: `<vault>/Projects/ucu-mcp/Releases/<version>.md`
   - Success: release note exists with date, version, commit SHA, key
     changes since previous release, and link to the npm registry page.

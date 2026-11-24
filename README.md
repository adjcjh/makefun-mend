# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/adjcjh/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/adjcjh/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files.
Models write edits in four formats, and `mend` reads them all:

- unified diffs (often with wrong line numbers),
- SEARCH/REPLACE blocks,
- V4A patches,
- text-editor tool calls as JSON.

It finds the lines each edit names at the first of three matching tiers
(exact, trailing-whitespace-insensitive, fully whitespace-insensitive),
re-indents replacements at the loosest tier, and writes every change or
nothing: a failed edit is reported and no file is written at all.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

- `PATCH` is the patch file, relative to the working directory (the root of
  the tree). When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto` (the default) detects it.
- `--check` does everything but write: same output and exit code, no file
  created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order; `--` ends the options.

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new`)
and `ok: <n> files`. Exit 1 prints one `error: <code> <path>` line per
failed edit and `failed: <k> of <n> edits`. Exit 2 prints a single error
line (`error: usage`, `error: no-patch`, `error: format`, or
`error: parse <N>`).

Node 22 or later, standard library only; nothing is installed.
`runner.ts` is the trial runner from the make.fun kit, kept as issued.

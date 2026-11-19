---
name: init-herdr-work-panel
description: Set up the current repository for the Herdr work-board panel, or bring an existing setup in line after the tracker changed. Writes .claude/work-board.json from the repo's existing mattpocock-skills tracker docs, excludes .claude/local/ from git, and adds a Work board section to the repo's agent instructions; on a repo already set up, shows what differs and asks before changing it. Use only when the user asks to set up, init, initialize, re-check or update the Herdr work panel/board for a repo.
---

# Init the Herdr work panel

Prepares one repository so the Herdr `work-board` panel and the `work-status` hook understand
it. It only reads the mattpocock-skills setup the repo already has; it never runs those skills.
Run on a repository that is already set up, it works out the same settings, compares them with
what is there, and changes nothing until the user agrees (step 6).

Work in the repository's main checkout: `git rev-parse --path-format=absolute --git-common-dir`,
minus the trailing `/.git`.

## 1. Check the prerequisites

Read `docs/agents/issue-tracker.md` and `docs/agents/triage-labels.md`. If `issue-tracker.md`
is missing, stop: tell the user to run the mattpocock `setup-matt-pocock-skills` skill first,
and change nothing.

## 2. Work out the settings

From those two files and git:

- `tracker`: `github` (GitHub Issues), `local` (markdown under `.scratch/`), or the tracker's
  lowercase name for anything else (`notion`, `linear`, `jira`, `gitlab`).
- `prefix`: how an issue is written in commits and chat. `#` for GitHub, `""` for local, and
  for other trackers the handle the doc shows (`CV-<n>` gives `"CV-"`, `ENG-123` gives `"ENG-"`).
  If the doc shows none, ask the user rather than guess.
- `ready`: the tracker's real value for the `ready-for-agent` role in `triage-labels.md` (a
  label name on GitHub, a `Status:` value for local, a status for others). Omit it if absent.
- `base`: the default branch, from `git symbolic-ref --short refs/remotes/origin/HEAD` minus
  `origin/`; else `main` if it exists, else the current branch.
- `skip_branches`: other long-lived branches that are not work, such as `release`, `develop`
  or `staging`, if they exist locally (`git branch --format='%(refname:short)'`). Omit if none.

Leave `ref` and `agent` out: the hook and panel derive them from `tracker` and `prefix`.

## 3. Write `.claude/work-board.json`

If the file is missing, write it, for example:

```json
{ "tracker": "notion", "prefix": "CV-", "ready": "Next", "base": "main", "skip_branches": ["release"] }
```

If it exists, don't touch it here: note each value that differs from step 2 for step 6. A key
step 2 didn't produce (`ref`, `agent`, or one the user added by hand) is theirs: keep it, and
list it in the report. This file is meant to be committed; don't commit it yourself unless the
user asks.

## 4. Keep the status file out of git

The hook writes `.claude/local/work-status.json`. Unless `.claude/local/` is already ignored
(`git check-ignore -q .claude/local/x`), add a line `.claude/local/` to `.git/info/exclude`
(use the common git dir, so worktrees share it).

## 5. Tell the agents

Add the section below to the repo's agent instructions: `CLAUDE.md` if it exists, else
`AGENTS.md`, else create `CLAUDE.md`. If a `## Work board` heading is already there, don't
touch it here: compare it with the section below for step 6 (the handles in its examples, the
agent-name form, the commands).
Replace `<P>` with an example issue handle for this repo (`CV-85`, `#12`, `auth-flow/03`) and
`<A>` with its agent-name form (`cv85`, `12`, `auth-flow-03`).

```markdown
## Work board

The Herdr work board shows which issues are in flight. It follows agents by name and reads the
rest from git and pull requests:

- Name every sub-agent that works an issue `<A>-<stage>`, stage one of `build`, `fix`, `qa`,
  `review`, `recheck`, `design` (e.g. `<A>-build`). Put ``branch `<name>` `` and
  ``worktree `<path>` `` in its prompt when it has them.
- Put the issue handle in commit subjects and pull request titles: `(<P>)`.
- When you start an issue, record its title: `work-status set <P> --title "<title>"`.
- To line up issues for this session: `work-status set <P> --queued --title "<title>"`.
- When you need the person on an issue: `work-status set <P> --waiting "<question>"`.

`work-status` comes from the herdr-work-board Claude Code plugin; `work-status show` prints
the board's file.
```

## 6. Already set up: ask before adjusting

Skip this step on a first setup. Otherwise, if anything from steps 3 and 5 differs:

1. Show each difference as `current → proposed`, e.g. `tracker: notion → local`,
   `prefix: "CV-" → ""`, and the Work board section's example handle `CV-85 → auth-flow/03`.
2. If `tracker` or `prefix` changes, issue handles change. Also say:
   - which issues in `.claude/local/work-status.json` (`work-status show`) no longer fit the new
     handle form: they will show with bare keys like `91`;
   - that commits and pull requests tagged with the old handle stop linking to cards.
3. Ask the user (AskUserQuestion, one question per item, recommended choice first):
   - update `.claude/work-board.json` (merge the proposed values; keep their own keys);
   - replace the `## Work board` section with the new text (show it);
   - if handles change: drop the issues that no longer fit (`work-status drop <id>` each), or
     keep them until their work is done.
4. Apply only what they agree to.

If nothing differs, say the setup is current and change nothing.

## 7. Report

Say what was found (tracker, prefix, ready value, base branch), which files were written,
changed or left alone and why, and anything that could not be worked out. Show the Work board section if
it was added. Then tell the user the Herdr Work button appears in the tab bar for this repo.

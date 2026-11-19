// Work board: the issues being worked right now in a repository, one card each, with the stage
// each is really at (Building, QA sweep, Waiting on you, Pull request open, Merged), then the
// issues queued for this session and the tracker's ready issues behind them. An issue with an
// open pull request shows its CI and a button that opens it in the browser.
//
// Works in any repository set up with the mattpocock skills (docs/agents/issue-tracker.md).
// Its .claude/work-board.json says how issues are named; the init-herdr-work-panel skill of the
// herdr-work-board Claude Code plugin writes it. Sources:
//  - <repo>/.claude/local/work-status.json, kept by that plugin's hooks: which agent is on an
//    issue, its title, what is queued, what waits on the person.
//  - git: each branch's commits ahead of the base branch, whether it is pushed, its worktree.
//  - gh: open pull requests with their checks, and the ones merged in the last half day.
//  - the tracker, only where reading it is free: GitHub Issues (gh) and local markdown
//    (.scratch/*/issues/*.md). Other trackers add nothing here.
// An issue is tied to a branch and pull request by its handle in commit subjects and titles.
//
// Without `props.folder` it follows the focused pane's repository.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, props, run } from "herdr";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MERGED_FOR = 12 * 3600000;
const MERGED_SHOWN = 4;
const READY_SHOWN = 5;

// Same defaults as the plugin's work-status hook: keep the two in step.
const DEFAULTS = {
  github: { prefix: "#", ref: "#(\\d+)", agent: "(?:issue-?|gh-?|#)?(\\d+)" },
  local: { prefix: "", ref: "\\b([a-z0-9][a-z0-9-]*)/(\\d{2})\\b", agent: "([a-z0-9][a-z0-9-]*?)-(\\d{2})(?=[-_ ]|$)" },
};
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function configOf(own) {
  const tracker = own.tracker ?? "github";
  const prefix = own.prefix ?? (DEFAULTS[tracker] ?? DEFAULTS.github).prefix;
  let base = DEFAULTS[tracker];
  if (!base) {
    const p = escape(prefix.replace(/-$/, ""));
    base = { prefix, ref: `\\b${p}-?(\\d+)\\b`, agent: `${p}-?(\\d+)(?=[-_ ]|$)` };
  }
  return { ...base, ...own, tracker, skip_branches: own.skip_branches ?? [] };
}
const keyOf = (m) => m.slice(1).filter((g) => g != null).join("/").toLowerCase();
const byKey = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

function span(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  return m < 1 ? "just now" : `${m}m`;
}

const BAD = ["FAILURE", "CANCELLED", "TIMED_OUT", "ERROR", "ACTION_REQUIRED", "STARTUP_FAILURE"];
function checksOf(rollup) {
  const runs = (rollup ?? []).filter((c) => (c.conclusion ?? c.state) !== "SKIPPED");
  if (!runs.length) return null;
  if (runs.some((c) => BAD.includes(c.conclusion) || BAD.includes(c.state))) return "failing";
  if (runs.some((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED")) return "running";
  return "passing";
}
// A pull request's CI in words: its state, and how far along its checks are.
function ciOf(rollup) {
  const state = checksOf(rollup);
  if (!state) return { state: null, text: "No CI checks yet" };
  const runs = (rollup ?? []).filter((c) => (c.conclusion ?? c.state) !== "SKIPPED");
  const failed = runs.filter((c) => BAD.includes(c.conclusion) || BAD.includes(c.state)).length;
  const done = runs.filter((c) => c.status === "COMPLETED" || (c.state && c.state !== "PENDING" && c.state !== "EXPECTED")).length;
  if (state === "failing") return { state, text: `CI failing · ${failed} of ${runs.length} failed` };
  if (state === "running") return { state, text: `CI running · ${done} of ${runs.length} done` };
  return { state, text: `CI passing · ${runs.length} of ${runs.length}` };
}

// A tracker's priority in a label or a "Priority:" line, as a rank: lower comes first.
function priorityRank(text) {
  const t = String(text ?? "").toLowerCase();
  if (/\b(p0|urgent|critical)\b/.test(t)) return 0;
  if (/\b(p1|high)\b/.test(t)) return 1;
  if (/\b(p2|medium|normal)\b/.test(t)) return 2;
  if (/\b(p3|low)\b/.test(t)) return 3;
  return 2.5;
}

export default class WorkBoard extends View {
  init(_props, cx) {
    this.status = { issues: {} }; this.branches = []; this.open = []; this.merged = []; this.tracker = {};
    this.error = null; this.root = null; this.cfg = configOf({});
    this.refresh(cx, true);
    // git and local files are cheap; GitHub goes on the slower beat.
    cx.timer.every(15000, (cx) => this.refresh(cx, false));
    cx.timer.every(60000, (cx) => this.refresh(cx, true));
  }

  folder() {
    const given = props()?.folder;
    if (given) return given;
    const f = focused(), pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    return pane?.cwd || f?.cwd || spaces().find((s) => s.active)?.folder || null;
  }

  // Every issue key in a commit subject or title. A squash merge's trailing "(#57)" is the
  // pull request's number, not an issue.
  keysIn(text) {
    const re = new RegExp(this.cfg.ref, "gi");
    const clean = String(text ?? "").replace(/\s*\(#\d+\)\s*$/, "");
    return [...new Set([...clean.matchAll(re)].map(keyOf))];
  }
  // A title read as its sentence: no conventional-commit type, issue handle or PR number.
  plain(title) {
    let s = String(title ?? "").replace(/\s*\(#\d+\)\s*$/, "").replace(/^[a-z]+(\([^)]*\))?!?:\s*/, "");
    s = s.replace(new RegExp(`\\s*\\(${this.cfg.ref}\\)\\s*$`, "i"), "");
    return s;
  }
  label(key) { return `${this.cfg.prefix}${key}`; }

  watch(dir, cx) {
    if (this.watched === dir) return;
    this.watched = dir;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === dir) {
          await watchFolder(dir);
          if (this.watched === dir) await this.readStatus(cx);
        }
      } catch { this.watched = null; }
    });
  }

  async readStatus(cx) {
    if (!this.root) return;
    const text = await readTextFile(`${this.root}/.claude/local/work-status.json`).catch(() => null);
    try { this.status = text ? JSON.parse(text) : { issues: {} }; } catch { /* mid-write: keep the last one */ }
    this.status.issues ??= this.status.cvs ?? {};
    cx.notify();
  }

  // Ready issues and titles from trackers that cost nothing to read.
  async readTracker(root, github) {
    const { tracker, ready } = this.cfg;
    if (tracker === "github" && github) {
      const r = await exec("gh", ["issue", "list", "--state", "open", "--limit", "100", "--json", "number,title,labels,createdAt"], { cwd: root }).catch(() => null);
      if (r?.code !== 0) return;
      const out = {};
      for (const i of JSON.parse(r.stdout)) {
        const labels = (i.labels ?? []).map((l) => l.name);
        out[String(i.number)] = { title: i.title, ready: Boolean(ready) && labels.includes(ready), priority: priorityRank(labels.join(" ")), created: i.createdAt };
      }
      this.tracker = out;
    } else if (tracker === "local") {
      const r = await exec("find", [`${root}/.scratch`, "-path", "*/issues/*.md", "-type", "f"], { cwd: root }).catch(() => null);
      if (r?.code !== 0) { this.tracker = {}; return; }
      const out = {};
      for (const path of r.stdout.split("\n").filter(Boolean).slice(0, 300)) {
        const m = /\.scratch\/([^/]+)\/issues\/(\d+)-[^/]*\.md$/.exec(path);
        if (!m) continue;
        const text = await readTextFile(path).catch(() => "");
        const status = /^Status:\s*(.+)$/im.exec(text)?.[1]?.trim() ?? "";
        const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? path.split("/").pop().replace(/^\d+-|\.md$/g, "").replace(/-/g, " ");
        out[`${m[1]}/${m[2]}`.toLowerCase()] = {
          title, ready: Boolean(ready) && status.toLowerCase() === ready.toLowerCase(),
          priority: priorityRank(/^Priority:\s*(.+)$/im.exec(text)?.[1]), created: "",
        };
      }
      this.tracker = out;
    } else this.tracker = {};
  }

  refresh(cx, github) {
    if (this.loading) return;
    const cwd = this.folder();
    if (!cwd) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        // The main checkout, even when the pane sits in a worktree: the status file lives there.
        const common = await exec("git", [...READ, "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
        if (common.code !== 0) { this.error = "Not a git repository"; this.root = null; return; }
        const root = common.stdout.trim().replace(/\/\.git\/?$/, "");
        if (root !== this.root) { this.status = { issues: {} }; this.branches = []; this.open = []; this.merged = []; this.tracker = {}; github = true; }
        this.root = root;
        const own = await readTextFile(`${root}/.claude/work-board.json`).then((t) => JSON.parse(t)).catch(() => ({}));
        this.cfg = configOf(own);
        this.setUp = await readTextFile(`${root}/docs/agents/issue-tracker.md`).then(() => true).catch(() => false);
        const git = (args) => exec("git", [...READ, ...args], { cwd: root });
        this.watch(`${root}/.claude/local`, cx);
        await this.readStatus(cx);

        let base = own.base;
        if (!base) {
          const head = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
          base = head.code === 0 ? head.stdout.trim().replace(/^origin\//, "") : "main";
        }
        this.base = base;
        const skip = new Set([base, ...this.cfg.skip_branches]);

        const trees = {};
        const wt = await git(["worktree", "list", "--porcelain"]);
        let path = null;
        for (const line of wt.stdout.split("\n")) {
          if (line.startsWith("worktree ")) path = line.slice(9);
          else if (line.startsWith("branch refs/heads/") && path) trees[line.slice(18)] = path;
        }
        const refs = await git(["for-each-ref", "refs/heads", "--format=%(refname:short)%09%(objectname)"]);
        const branches = [];
        for (const line of refs.stdout.split("\n").filter(Boolean)) {
          const [name, sha] = line.split("\t");
          if (skip.has(name)) continue;
          const log = await git(["log", "--format=%s", `origin/${base}..${name}`]);
          const subjects = log.code === 0 ? log.stdout.split("\n").filter(Boolean) : [];
          const remote = await git(["rev-parse", "-q", "--verify", `refs/remotes/origin/${name}`]);
          let dirty = 0;
          if (trees[name]) {
            const st = await exec("git", [...READ, "status", "--porcelain"], { cwd: trees[name] }).catch(() => null);
            dirty = st?.code === 0 ? st.stdout.split("\n").filter(Boolean).length : 0;
          }
          branches.push({
            name, ahead: subjects.length, subject: subjects[0] ?? "", keys: this.keysIn(subjects.join("\n") + "\n" + name),
            pushed: remote.code !== 0 ? "no" : remote.stdout.trim() === sha ? "yes" : "behind", worktree: trees[name] ?? null, dirty,
          });
        }
        this.branches = branches;

        if (github) {
          const fields = "number,title,headRefName,url,isDraft,statusCheckRollup" + (this.cfg.tracker === "github" ? ",closingIssuesReferences" : "");
          const open = await exec("gh", ["pr", "list", "--state", "open", "--limit", "30", "--json", fields], { cwd: root }).catch(() => null);
          if (open?.code === 0) this.open = JSON.parse(open.stdout);
          const merged = await exec("gh", ["pr", "list", "--state", "merged", "--limit", "10", "--json", "number,title,headRefName,url,mergedAt"], { cwd: root }).catch(() => null);
          if (merged?.code === 0) this.merged = JSON.parse(merged.stdout);
          this.github = open?.code === 0 ? null : "gh could not list pull requests";
        }
        await this.readTracker(root, github);
        this.error = null; this.checked = Date.now();
      } catch (e) { this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // One card per issue in flight, the most pressing first.
  cards(now) {
    const rows = {};
    const row = (k) => (rows[k] ??= { key: k, agents: [], branch: null, pr: null, merged: null });
    for (const [k, s] of Object.entries(this.status.issues ?? {})) {
      const r = row(k);
      r.title = s.title; r.note = s.note; r.waiting = s.waiting; r.named = s.branch; r.queued = s.queued;
      r.agents = Object.entries(s.agents ?? {}).map(([name, a]) => ({ name, ...a }));
    }
    for (const b of this.branches) {
      const owners = b.keys.length ? b.keys : Object.keys(rows).filter((k) => rows[k].named === b.name);
      for (const k of owners) row(k).branch ??= b;
    }
    const prKeys = (pr) => [...new Set([...this.keysIn(pr.title), ...this.keysIn(pr.headRefName), ...(pr.closingIssuesReferences ?? []).map((i) => String(i.number))])];
    for (const pr of this.open) for (const k of prKeys(pr)) row(k).pr = pr;
    for (const pr of this.merged) {
      if (now - Date.parse(pr.mergedAt) > MERGED_FOR) continue;
      for (const k of prKeys(pr)) row(k).merged ??= pr;
    }

    const t = theme(), out = [];
    for (const r of Object.values(rows)) {
      const running = r.agents.filter((a) => a.state === "running").sort((a, b) => (a.since < b.since ? 1 : -1))[0];
      const last = r.agents.slice().sort((a, b) => (a.since < b.since ? 1 : -1))[0];
      const b = r.branch;
      let stage, color, rank, detail = "", spin = false;
      if (r.waiting) { stage = "Waiting on you"; color = t.blocked; rank = 0; detail = r.waiting.question; }
      else if (running) { stage = running.stage; color = t.working; rank = 1; spin = true; detail = `${running.name} · ${span(now - Date.parse(running.since))}`; }
      else if (r.pr) {
        const checks = checksOf(r.pr.statusCheckRollup);
        stage = r.pr.isDraft ? "Draft pull request" : "Pull request open"; rank = 2;
        color = checks === "failing" ? t.blocked : checks === "running" ? t.working : t.done;
        detail = `#${r.pr.number}`;
      } else if (b && b.ahead > 0) {
        stage = last ? `${last.stage} finished` : b.pushed === "yes" ? "Pushed, no pull request" : "Committed, not pushed";
        color = t.done; rank = 3; detail = last ? `${last.name} · idle ${span(now - Date.parse(last.since))}` : "";
      } else if (r.merged) { stage = "Merged"; color = t.dim; rank = 5; detail = `#${r.merged.number} · ${span(now - Date.parse(r.merged.mergedAt))} ago`; }
      else if (last) { stage = `${last.stage} finished`; color = t.idle; rank = 4; detail = `${last.name} · idle ${span(now - Date.parse(last.since))}`; }
      // Lined up for this session and not begun: after the work in flight, in the order queued.
      else if (r.queued) { stage = "Queued"; color = t.idle; rank = 4.5; }
      else if (r.title || r.note) { stage = "Not started"; color = t.dim; rank = 4; }
      else continue;
      // An issue whose work merged and whose agents are long idle is history, not work in flight.
      if (rank === 4 && last && !b && now - Date.parse(last.since) > MERGED_FOR) continue;
      const title = this.tracker[r.key]?.title || r.title || this.plain(r.pr?.title) || this.plain(r.merged?.title) || this.plain(b?.subject) || last?.about || "";
      const facts = [];
      if (b && rank !== 5) {
        facts.push(b.name, `${b.ahead} commit${b.ahead === 1 ? "" : "s"}`);
        facts.push(b.pushed === "yes" ? "pushed" : b.pushed === "behind" ? "push pending" : "not pushed");
        if (b.dirty) facts.push(`${b.dirty} uncommitted`);
      } else if (r.named && rank !== 5) facts.push(r.named);
      // The pull request's CI shows whatever stage the issue is at: a fix agent can be running on one.
      const ci = r.pr ? ciOf(r.pr.statusCheckRollup) : null;
      out.push({ ...r, stage, color, rank, detail, spin, title, facts, ci, url: r.pr?.url ?? r.merged?.url ?? null, since: (running ?? last)?.since ?? "" });
    }
    const line = out.filter((c) => c.rank === 4.5).sort((a, b) => (a.queued < b.queued ? -1 : a.queued > b.queued ? 1 : byKey(a.key, b.key)));
    line.forEach((c, i) => { c.place = i; c.detail = i === 0 ? "next up" : `${i + 1} in line`; });

    // The tracker's ready issues nobody has touched: by priority, then oldest.
    const ready = Object.entries(this.tracker).filter(([k, i]) => i.ready && !rows[k])
      .sort(([ka, a], [kb, b]) => a.priority - b.priority || (a.created && b.created ? (a.created < b.created ? -1 : 1) : byKey(ka, kb)))
      .slice(0, READY_SHOWN);
    ready.forEach(([key, i], n) => out.push({ key, agents: [], stage: "Ready", color: t.dim, rank: 4.6, place: n, detail: "", spin: false, title: i.title, facts: [], ci: null, url: null, since: "" }));

    return out.sort((a, b) => a.rank - b.rank || (a.rank >= 4.5 && a.rank < 5 ? a.place - b.place : byKey(b.key, a.key)));
  }

  // The pane working in an issue's worktree, to jump to.
  paneFor(card) {
    const dir = card.branch?.worktree;
    return dir ? panes().find((p) => p.cwd && (p.cwd === dir || p.cwd.startsWith(dir + "/"))) ?? null : null;
  }

  openButton(id, text, url, t, strong) {
    return div().id(id).flex_none().px(6).py(1).rounded(4).border_1().border_color(t.border).text_color(strong ? t.foreground : t.muted).cursor_pointer()
      .hover((s) => s.bg(t.raised)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); cx.spawn(async () => { await exec("open", [url]).catch(() => null); }); })
      .child(text);
  }

  card(c, t) {
    const pane = this.paneFor(c), id = c.key.replace(/[^a-z0-9]/gi, "-");
    return v_flex().id(`issue-${id}`).flex_none().p(10).gap(5).rounded(8).bg(t.surface).border_1().border_color(c.rank === 0 ? c.color : t.border)
      .when(Boolean(pane), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => run("pane.focus", { pane: pane.pane })))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().font_semibold().text_color(t.muted).child(this.label(c.key)))
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(c.title || "Untitled")))
      .child(h_flex().gap(6).items_center()
        .child(div().w(12).flex_none().text_color(c.color).when(c.spin, (el) => el.frames(SPIN, 90)).when(!c.spin, (el) => el.child("●")))
        .child(div().flex_none().text_color(c.color).child(c.stage))
        .when(Boolean(c.detail) && c.rank !== 0, (el) => el.child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(c.detail))))
      .when(c.rank === 0, (el) => el.child(div().text_color(t.foreground).child(c.detail)))
      .when(Boolean(c.note), (el) => el.child(div().text_color(t.muted).child(c.note)))
      .when(Boolean(c.pr), (el) => {
        const ciColor = c.ci?.state === "failing" ? t.blocked : c.ci?.state === "running" ? t.working : c.ci?.state === "passing" ? t.done : t.dim;
        return el.child(h_flex().gap(6).items_center().text_size(11)
          .child(div().w(12).flex_none().text_color(ciColor).when(c.ci?.state === "running", (e) => e.frames(SPIN, 90)).when(c.ci?.state !== "running", (e) => e.child("●")))
          .child(div().flex_1().min_w(0).truncate().text_color(ciColor).child(c.ci?.text ?? ""))
          .child(this.openButton(`open-${id}`, `Open #${c.pr.number} ↗`, c.pr.url, t, true)));
      })
      .when(c.facts.length > 0 || (Boolean(c.url) && !c.pr), (el) => el.child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(c.facts.join(" · ")))
        .when(Boolean(c.url) && !c.pr, (e) => e.child(this.openButton(`pr-${id}`, `#${c.merged?.number}`, c.url, t, false)))));
  }

  // A merged issue: one line, its pull request a click away.
  mergedRow(c, t) {
    return h_flex().id(`merged-${c.key.replace(/[^a-z0-9]/gi, "-")}`).flex_none().h(24).px(8).gap(8).items_center().rounded(6).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.spawn(async () => { await exec("open", [c.url]).catch(() => null); }); })
      .child(div().flex_none().text_color(t.dim).child(this.label(c.key)))
      .child(div().flex_1().min_w(0).truncate().child(c.title || "Untitled"))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(c.detail));
  }

  render() {
    const t = theme(), now = Date.now(), cards = this.cards(now);
    const live = cards.filter((c) => c.rank < 5);
    const merged = cards.filter((c) => c.rank === 5).sort((a, b) => Date.parse(b.merged.mergedAt) - Date.parse(a.merged.mergedAt)).slice(0, MERGED_SHOWN);
    const name = this.root ? this.root.split("/").pop() : "";
    const empty = this.error || (!this.root ? (this.loading ? "Loading…" : "No folder")
      : this.setUp === false ? "This repository has no docs/agents/issue-tracker.md: run init-herdr-work-panel in Claude Code."
      : "Nothing in flight.");
    return v_flex().id("work-board").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12)
      .child(h_flex().h(38).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(13).child("Work in flight"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(name))
        .child(div().id("work-refresh").flex_none().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(11).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.raised)).on_click((_e, cx) => this.refresh(cx, true)).child(this.loading ? "…" : "Refresh")))
      .child(v_flex().id("work-list").flex_1().min_h(0).overflow_y_scroll().p(8).gap(8)
        .children(live.map((c) => this.card(c, t)))
        .when(!live.length, (el) => el.child(div().p(8).text_color(t.dim).child(empty)))
        .when(merged.length > 0, (el) => el.child(div().flex_none().pt(4).px(2).text_size(11).text_color(t.dim).child("Merged")).child(v_flex().flex_none().children(merged.map((c) => this.mergedRow(c, t)))))
        .when(Boolean(this.github), (el) => el.child(div().flex_none().px(2).text_size(11).text_color(t.dim).child(this.github))));
  }
}

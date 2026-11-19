// CV board: the Coverage Portal work rows being worked right now, one card each, with the
// stage each is really at (Building, QA sweep, Waiting on you, Pull request open, Merged), and
// the rows queued for this session behind them. A row with an open pull request shows its CI
// and a button that opens it in the browser.
//
// Three sources, none of them Notion:
//  - <repo>/.claude/local/work-status.json, kept by Claude Code hooks in that repo
//    (.claude/local/work-status.py): which agent is on a row, and what waits on the person.
//    The agents run inside one Claude session, so Herdr cannot see them itself.
//  - git: each branch's commits ahead of origin/main, whether it is pushed, its worktree.
//  - gh: open pull requests with their checks, and the ones merged in the last half day.
// A row is tied to a branch by the "(CV-85)" its commit subjects and pull request title carry.
//
// A pane mod: `pane.split { direction, mod: "cv-board", props: { folder: "<repo>" } }`. Without
// `folder` it follows the focused pane's repository.

import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, props, run } from "herdr";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false"];
const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MERGED_FOR = 12 * 3600000;
// Merged rows are history: one line each, and only the newest few.
const MERGED_SHOWN = 4;
const CV = /\bCV-(\d+)\b/gi;

function span(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m >= 1440) return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  return m < 1 ? "just now" : `${m}m`;
}
const numbersIn = (text) => [...new Set([...(text ?? "").matchAll(CV)].map((m) => m[1]))];
// "feat: an untouched remediation closes itself (CV-83) (#57)" reads as its sentence.
const plain = (title) => (title ?? "").replace(/\s*\(#\d+\)\s*$/, "").replace(/\s*\(CV-\d+\)\s*$/i, "").replace(/^[a-z]+(\([^)]*\))?:\s*/, "");

function checksOf(rollup) {
  const runs = (rollup ?? []).filter((c) => (c.conclusion ?? c.state) !== "SKIPPED");
  if (!runs.length) return null;
  const bad = ["FAILURE", "CANCELLED", "TIMED_OUT", "ERROR", "ACTION_REQUIRED", "STARTUP_FAILURE"];
  if (runs.some((c) => bad.includes(c.conclusion) || bad.includes(c.state))) return "failing";
  if (runs.some((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED")) return "running";
  return "passing";
}

// A pull request's CI in words: its state, and how far along its checks are.
function ciOf(rollup) {
  const state = checksOf(rollup);
  if (!state) return { state: null, text: "No CI checks yet" };
  const runs = (rollup ?? []).filter((c) => (c.conclusion ?? c.state) !== "SKIPPED");
  const bad = ["FAILURE", "CANCELLED", "TIMED_OUT", "ERROR", "ACTION_REQUIRED", "STARTUP_FAILURE"];
  const failed = runs.filter((c) => bad.includes(c.conclusion) || bad.includes(c.state)).length;
  const done = runs.filter((c) => c.status === "COMPLETED" || (c.state && c.state !== "PENDING" && c.state !== "EXPECTED")).length;
  if (state === "failing") return { state, text: `CI failing · ${failed} of ${runs.length} failed` };
  if (state === "running") return { state, text: `CI running · ${done} of ${runs.length} done` };
  return { state, text: `CI passing · ${runs.length} of ${runs.length}` };
}

export default class CvBoard extends View {
  init(_props, cx) {
    this.status = { cvs: {} }; this.branches = []; this.open = []; this.merged = []; this.error = null; this.root = null;
    this.refresh(cx, true);
    // git is cheap and local; gh asks GitHub, so it goes on the slower beat.
    cx.timer.every(15000, (cx) => this.refresh(cx, false));
    cx.timer.every(60000, (cx) => this.refresh(cx, true));
  }

  folder() {
    const given = props()?.folder;
    if (given) return given;
    const f = focused(), pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    return pane?.cwd || f?.cwd || spaces().find((s) => s.active)?.folder || null;
  }

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
    try { this.status = text ? JSON.parse(text) : { cvs: {} }; } catch { /* mid-write: keep the last one */ }
    this.status.cvs ??= {};
    cx.notify();
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
        this.root = root;
        const git = (args) => exec("git", [...READ, ...args], { cwd: root });
        this.watch(`${root}/.claude/local`, cx);
        await this.readStatus(cx);

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
          if (name === "main" || name === "release") continue;
          const log = await git(["log", "--format=%s", `origin/main..${name}`]);
          const subjects = log.code === 0 ? log.stdout.split("\n").filter(Boolean) : [];
          const remote = await git(["rev-parse", "-q", "--verify", `refs/remotes/origin/${name}`]);
          let dirty = 0;
          if (trees[name]) {
            const st = await exec("git", [...READ, "status", "--porcelain"], { cwd: trees[name] }).catch(() => null);
            dirty = st?.code === 0 ? st.stdout.split("\n").filter(Boolean).length : 0;
          }
          branches.push({
            name, ahead: subjects.length, subject: subjects[0] ?? "", cvs: numbersIn(subjects.join("\n")),
            pushed: remote.code !== 0 ? "no" : remote.stdout.trim() === sha ? "yes" : "behind", worktree: trees[name] ?? null, dirty,
          });
        }
        this.branches = branches;

        if (github) {
          const open = await exec("gh", ["pr", "list", "--state", "open", "--limit", "30", "--json", "number,title,headRefName,url,isDraft,statusCheckRollup"], { cwd: root }).catch(() => null);
          if (open?.code === 0) this.open = JSON.parse(open.stdout);
          const merged = await exec("gh", ["pr", "list", "--state", "merged", "--limit", "10", "--json", "number,title,headRefName,url,mergedAt"], { cwd: root }).catch(() => null);
          if (merged?.code === 0) this.merged = JSON.parse(merged.stdout);
          this.github = open?.code === 0 ? null : "gh could not list pull requests";
        }
        this.error = null; this.checked = Date.now();
      } catch (e) { this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // One card per row in flight, the most pressing first.
  cards(now) {
    const rows = {};
    const row = (n) => (rows[n] ??= { cv: n, agents: [], branch: null, pr: null, merged: null });
    for (const [n, s] of Object.entries(this.status.cvs ?? {})) {
      const r = row(n);
      r.title = s.title; r.note = s.note; r.waiting = s.waiting; r.named = s.branch; r.queued = s.queued;
      r.agents = Object.entries(s.agents ?? {}).map(([name, a]) => ({ name, ...a }));
    }
    for (const b of this.branches) {
      const owners = b.cvs.length ? b.cvs : Object.keys(rows).filter((n) => rows[n].named === b.name);
      for (const n of owners) row(n).branch ??= b;
    }
    for (const pr of this.open) for (const n of numbersIn(pr.title)) row(n).pr = pr;
    for (const pr of this.merged) {
      if (now - Date.parse(pr.mergedAt) > MERGED_FOR) continue;
      for (const n of numbersIn(pr.title)) row(n).merged ??= pr;
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
      // A row whose work merged and whose agents are long idle is history, not work in flight.
      if (rank === 4 && last && !b && now - Date.parse(last.since) > MERGED_FOR) continue;
      const title = r.title || plain(r.pr?.title) || plain(r.merged?.title) || plain(b?.subject) || last?.about || "";
      const facts = [];
      if (b && rank !== 5) {
        facts.push(b.name, `${b.ahead} commit${b.ahead === 1 ? "" : "s"}`);
        facts.push(b.pushed === "yes" ? "pushed" : b.pushed === "behind" ? "push pending" : "not pushed");
        if (b.dirty) facts.push(`${b.dirty} uncommitted`);
      } else if (r.named && rank !== 5) facts.push(r.named);
      // The pull request's CI shows whatever stage the row is at: a fix agent can be running on one.
      const ci = r.pr ? ciOf(r.pr.statusCheckRollup) : null;
      out.push({ ...r, stage, color, rank, detail, spin, title, facts, ci, url: r.pr?.url ?? r.merged?.url ?? null, since: (running ?? last)?.since ?? "" });
    }
    const line = out.filter((c) => c.rank === 4.5).sort((a, b) => (a.queued < b.queued ? -1 : a.queued > b.queued ? 1 : Number(a.cv) - Number(b.cv)));
    line.forEach((c, i) => { c.place = i; c.detail = i === 0 ? "next up" : `${i + 1} in line`; });
    return out.sort((a, b) => a.rank - b.rank || (a.rank === 4.5 ? a.place - b.place : Number(b.cv) - Number(a.cv)));
  }

  // The pane working in a row's worktree, to jump to.
  paneFor(card) {
    const dir = card.branch?.worktree;
    return dir ? panes().find((p) => p.cwd && (p.cwd === dir || p.cwd.startsWith(dir + "/"))) ?? null : null;
  }

  card(c, t) {
    const pane = this.paneFor(c);
    return v_flex().id(`cv-${c.cv}`).flex_none().p(10).gap(5).rounded(8).bg(t.surface).border_1().border_color(c.rank === 0 ? c.color : t.border)
      .when(Boolean(pane), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => run("pane.focus", { pane: pane.pane })))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_none().font_semibold().text_color(t.muted).child(`CV-${c.cv}`))
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
          .child(div().id(`open-${c.cv}`).flex_none().px(6).py(1).rounded(4).border_1().border_color(t.border).text_color(t.foreground).cursor_pointer()
            .hover((s) => s.bg(t.raised)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
            .on_click((_e, cx) => { cx.stop_propagation(); cx.spawn(async () => { await exec("open", [c.pr.url]).catch(() => null); }); })
            .child(`Open #${c.pr.number} ↗`)));
      })
      .when(c.facts.length > 0 || (Boolean(c.url) && !c.pr), (el) => el.child(h_flex().gap(6).items_center().text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(c.facts.join(" · ")))
        .when(Boolean(c.url) && !c.pr, (e) => e.child(div().id(`pr-${c.cv}`).flex_none().px(6).py(1).rounded(4).border_1().border_color(t.border).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.raised)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); cx.spawn(async () => { await exec("open", [c.url]).catch(() => null); }); })
          .child(`#${c.merged.number}`)))));
  }

  // A merged row: one line, its pull request a click away.
  mergedRow(c, t) {
    return h_flex().id(`merged-${c.cv}`).flex_none().h(24).px(8).gap(8).items_center().rounded(6).text_color(t.muted).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { cx.spawn(async () => { await exec("open", [c.url]).catch(() => null); }); })
      .child(div().flex_none().text_color(t.dim).child(`CV-${c.cv}`))
      .child(div().flex_1().min_w(0).truncate().child(c.title || "Untitled"))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(c.detail));
  }

  render(cx) {
    const t = theme(), now = Date.now(), cards = this.cards(now);
    const live = cards.filter((c) => c.rank < 5);
    const merged = cards.filter((c) => c.rank === 5).sort((a, b) => Date.parse(b.merged.mergedAt) - Date.parse(a.merged.mergedAt)).slice(0, MERGED_SHOWN);
    const name = this.root ? this.root.split("/").pop() : "";
    return v_flex().id("cv-board").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(12)
      .child(h_flex().h(38).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().text_size(13).child("Work in flight"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(name))
        .child(div().id("cv-refresh").flex_none().px(6).py(1).rounded(4).border_1().border_color(t.border).text_size(11).text_color(t.muted).cursor_pointer()
          .hover((s) => s.bg(t.raised)).on_click((_e, cx) => this.refresh(cx, true)).child(this.loading ? "…" : "Refresh")))
      .child(v_flex().id("cv-list").flex_1().min_h(0).overflow_y_scroll().p(8).gap(8)
        .children(live.map((c) => this.card(c, t)))
        .when(!live.length, (el) => el.child(div().p(8).text_color(t.dim).child(this.error || (this.root ? "Nothing in flight." : this.loading ? "Loading…" : "No folder"))))
        .when(merged.length > 0, (el) => el.child(div().flex_none().pt(4).px(2).text_size(11).text_color(t.dim).child("Merged")).child(v_flex().flex_none().children(merged.map((c) => this.mergedRow(c, t)))))
        .when(Boolean(this.github), (el) => el.child(div().flex_none().px(2).text_size(11).text_color(t.dim).child(this.github))));
  }
}

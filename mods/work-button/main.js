// The tab bar's "Work" button, beside Files and Changes: it opens the work-board panel (the
// issues in flight) in the right-hand panel. It shows only while the active space is working
// in a repository set up with the mattpocock skills (docs/agents/issue-tracker.md); elsewhere
// its block is 0px wide.
//
// It sits in its own block to the right of the shipped `tabs` bar, so that bar stays Herdr's
// and keeps its updates. The layout needs two things (layouts/my-main.json has both): this
// block, id "work-button", in a row with the tabs block; and a block with id "work-board" in
// the "panel-body" stack.

import { View, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, theme, layout, exec, readTextFile } from "herdr";

const WIDTH = 78;
const RECHECK_MS = 30000;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class WorkButton extends View {
  init(_props, cx) {
    // Per folder: whether it is in a repository set up for the board. A yes is kept; a no is
    // asked again every RECHECK_MS in the background, and only a flip to yes redraws, so a
    // repository set up while Herdr runs gets its button without a reload or idle redraws.
    this.setUp = {};
    cx.timer.every(RECHECK_MS, (cx) => {
      const nos = Object.keys(this.setUp).filter((cwd) => this.setUp[cwd] === false);
      if (nos.length === 0) return;
      cx.spawn(async (cx) => {
        let flipped = false;
        for (const cwd of nos) {
          if (await this.check(cwd)) { this.setUp[cwd] = true; flipped = true; }
        }
        if (flipped) cx.notify();
      });
    });
  }

  // Whether cwd is in a repository with docs/agents/issue-tracker.md (readTextFile gives null
  // for a missing file).
  async check(cwd) {
    const r = await exec("git", ["--no-optional-locks", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd }).catch(() => null);
    const root = r?.code === 0 ? r.stdout.trim().replace(/\/\.git\/?$/, "") : null;
    if (!root) return false;
    return readTextFile(`${root}/docs/agents/issue-tracker.md`).then((text) => text != null).catch(() => false);
  }

  // Unknown folders count as no until git and the file system have answered; the answer redraws.
  inSetUpRepo(cwd, cx) {
    if (!cwd) return false;
    if (cwd in this.setUp) return this.setUp[cwd] === true;
    this.setUp[cwd] = null;
    cx.spawn(async (cx) => {
      this.setUp[cwd] = await this.check(cwd);
      cx.notify();
    });
    return false;
  }

  // Whether the active space is working in such a repository: one of its panes is in one now.
  // Spaces on other machines don't count: the board reads this machine's files.
  here(cx) {
    const space = spaces().find((s) => s.active);
    if (!space || space.machine) return false;
    const tabs = new Set((space.tabs ?? []).map((t) => t.id));
    return panes().filter((p) => tabs.has(p.tab)).some((p) => this.inSetUpRepo(p.cwd, cx));
  }

  render(cx) {
    const t = theme(), root = layout(), me = find(root, "work-button");
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const here = this.here(cx), want = here ? WIDTH : 0;
    // Asked once per change: the layout answers on a later render.
    if (me && (me.size?.px ?? 0) !== want) {
      if (this.asked !== want) { this.asked = want; run("layout.resize", { id: "work-button", px: want }); }
    } else this.asked = null;
    const on = Boolean(panel) && !panel.hidden && body?.active === "work-board";
    return h_flex().size_full().min_w(0).overflow_hidden().pr(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .when(here && Boolean(panel) && Boolean(body), (el) => el.child(
        h_flex().id("panel-work-board").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
          .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => {
            if (on) run("layout.hide", { id: "panel" });
            else { run("layout.select", { stack: "panel-body", child: "work-board" }); run("layout.show", { id: "panel" }); }
          }).child(svg("mods/work-button/board.svg").size(14)).child("Work")));
  }
}

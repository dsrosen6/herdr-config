// The tab bar's "Work" button, beside Files and Changes: it opens the cv-board panel (the
// CV rows in flight) in the right-hand panel, and shows only while the active space is in
// the project its block names (`props.folder`). Elsewhere its block is 0px wide.
//
// It sits in its own block to the right of the shipped `tabs` bar, so that bar stays
// Herdr's and keeps its updates. The layout needs two things (layouts/my-main.json has
// both): this block, id "cv-button", in a row with the tabs block; and a block with id
// "cv-board" in the "panel-body" stack.

import { View, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, run, theme, layout, props, exec } from "herdr";

const WIDTH = 78;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const under = (path, root) => Boolean(path) && (path === root || path.startsWith(root + "/"));

export default class CvButton extends View {
  init() {
    // Each folder outside the project asked once: whether it is one of the project's worktrees.
    this.repoOf = {};
  }

  // Whether a folder is in the project: under it, or a worktree of it kept elsewhere
  // (Herdr's are in ~/.herdr/worktrees/<repo>/<branch>), which only git can say. Until git
  // has answered it counts as outside, and the answer redraws the button.
  inProject(cwd, root, cx) {
    if (!cwd) return false;
    if (under(cwd, root)) return true;
    if (cwd in this.repoOf) return this.repoOf[cwd] === root;
    this.repoOf[cwd] = null;
    cx.spawn(async (cx) => {
      const r = await exec("git", ["--no-optional-locks", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd }).catch(() => null);
      this.repoOf[cwd] = r?.code === 0 ? r.stdout.trim().replace(/\/\.git\/?$/, "") : "";
      cx.notify();
    });
    return false;
  }

  // Whether the active space is working in the project: one of its panes is in it now. Not
  // the space's own `folder`, which is where it was made: a space made here and since moved
  // to another repo kept the button.
  here(cx) {
    const root = props()?.folder, space = spaces().find((s) => s.active);
    if (!root || !space) return false;
    const tabs = new Set((space.tabs ?? []).map((t) => t.id));
    return panes().filter((p) => tabs.has(p.tab)).some((p) => this.inProject(p.cwd, root, cx));
  }

  render(cx) {
    const t = theme(), root = layout(), me = find(root, "cv-button");
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const here = this.here(cx), want = here ? WIDTH : 0;
    // Asked once per change: the layout answers on a later render.
    if (me && (me.size?.px ?? 0) !== want) {
      if (this.asked !== want) { this.asked = want; run("layout.resize", { id: "cv-button", px: want }); }
    } else this.asked = null;
    const on = Boolean(panel) && !panel.hidden && body?.active === "cv-board";
    return h_flex().size_full().min_w(0).overflow_hidden().pr(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .when(here && Boolean(panel) && Boolean(body), (el) => el.child(
        h_flex().id("panel-cv-board").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
          .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => {
            if (on) run("layout.hide", { id: "panel" });
            else { run("layout.select", { stack: "panel-body", child: "cv-board" }); run("layout.show", { id: "panel" }); }
          }).child(svg("mods/cv-button/board.svg").size(14)).child("Work")));
  }
}

// The tab bar's "Usage" button, beside Files, Changes and Work: it opens the full Claude
// Usage view (the usage mod with props.panel) in the right-hand panel, and closes it again.
//
// It sits in its own block to the right of the shipped `tabs` bar, so that bar stays Herdr's.
// The layout needs this block, id "usage-button", in a row with the tabs block, and a block
// with id "usage-panel" in the "panel-body" stack.
//
// Per-space memory: the shipped tab bar remembers which panel each space had open, but on a
// space switch only restores ids listed in shared "workspace.panels" (default Files and
// Changes). This button adds the Work and Usage panels there, so they come back per space
// like Files and Changes. The tab bar draws buttons only for files and changes, so the extra
// ids add no buttons; the welcome screen's panel picker keeps ids it doesn't know.

import { View, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { run, theme, layout, shared, setShared } from "herdr";

const REMEMBERED = ["work-board", "usage-panel"];

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class UsageButton extends View {
  init() { this.remember(); }

  remember() {
    const list = shared("workspace.panels") ?? ["files", "changes"];
    const missing = REMEMBERED.filter((id) => !list.includes(id));
    if (missing.length) setShared("workspace.panels", [...list, ...missing]);
  }

  render() {
    const t = theme(), root = layout();
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const on = Boolean(panel) && !panel.hidden && body?.active === "usage-panel";
    return h_flex().size_full().min_w(0).overflow_hidden().pr(10).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .when(Boolean(panel) && Boolean(body), (el) => el.child(
        h_flex().id("panel-usage").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
          .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click(() => {
            if (on) run("layout.hide", { id: "panel" });
            else { run("layout.select", { stack: "panel-body", child: "usage-panel" }); run("layout.show", { id: "panel" }); }
          }).child(svg("mods/usage-button/gauge.svg").size(14)).child("Usage")));
  }
}

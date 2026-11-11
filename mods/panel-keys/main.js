// Keys for the right-hand panel: `panel-keys.changes` / `panel-keys.files`
// toggle that panel like its tab-bar button (show it on that view, or hide it
// when it's already showing). Draws nothing; lives in a 0px block.

import { View, div } from "gpui-kit";
import { run, layout, nextCommand } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class PanelKeys extends View {
  init(_props, cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "changes" || c === "files") this.toggle(c);
      }
    });
  }

  toggle(id) {
    const root = layout();
    const panel = find(root, "panel"), body = find(root, "panel-body");
    if (!panel || !body) return;
    if (!panel.hidden && body.active === id) run("layout.hide", { id: "panel" });
    else {
      run("layout.select", { stack: "panel-body", child: id });
      run("layout.show", { id: "panel" });
    }
  }

  render() {
    return div();
  }
}

// Asks for a worktree name, then opens a new tab running
// `claude --worktree <name>` in the focused terminal's folder.
// Empty name: Claude picks one. Enter starts, Esc cancels.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, theme } from "herdr";

export default class ClaudeWorktree extends View {
  init(_props, cx) {
    this.text = "";
    this.input = InputState.new({ value: "", placeholder: "worktree name" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); cx.notify(); });
    this.input.on("submit", () => this.submit());
    this.inputFocused = true;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    this.handle = cx.focus_handle();
    this.input.focus();
    cx.timer.after(150, () => this.input.focus());
  }

  close() {
    closeOverlay(props()?.overlay);
  }

  submit() {
    const name = this.text.trim();
    this.close();
    run("tab.new", name ? { name, argv: ["claude", "--worktree", name] } : { argv: ["claude", "--worktree"] });
  }

  key(e, cx) {
    if (e.key === "escape") { this.close(); cx.stop_propagation(); }
  }

  render() {
    const t = theme();
    return v_flex().id("claude-worktree").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().p(16).gap(10).bg(t.popover).text_size(13)
      .child(div().font_semibold().text_color(t.foreground).child("New Claude worktree"))
      .child(div().text_color(t.muted).child("Opens a tab running claude --worktree with this name."))
      .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1)
        .border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
      .child(div().flex_1())
      .child(h_flex().justify_end().text_size(11).text_color(t.dim).child("↵ start · esc cancel"));
  }
}

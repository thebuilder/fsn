/**
 * Lets a modal dialog be dismissed by pressing the page behind it.
 *
 * A modal's backdrop is painted by the dialog itself, so a press on it arrives with the
 * dialog as its target — which is also what a press on the dialog's own padding would
 * look like, and none of these have any. Both ends of the press are checked, so text
 * selected inside the frame and released outside it, or a window dragged by its title
 * bar past the edge, is not read as a dismissal.
 *
 * `onDismiss` is for dialogs that own something to ask first; without it the dialog is
 * simply closed, which is what Escape already does to the same dialogs.
 */
export function dismissOnOutsidePress(
  dialog: HTMLDialogElement,
  options: { signal: AbortSignal; onDismiss?: () => void },
): void {
  const listener = { signal: options.signal };
  let startedOutside = false;
  dialog.addEventListener("pointerdown", (event) => {
    startedOutside = event.target === dialog;
  }, listener);
  dialog.addEventListener("click", (event) => {
    if (!startedOutside || event.target !== dialog) return;
    startedOutside = false;
    if (options.onDismiss) options.onDismiss();
    else dialog.close();
  }, listener);
}

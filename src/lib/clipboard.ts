/**
 * Copies text to the clipboard and reports whether it worked, so callers only
 * show "Copied" on success. The Clipboard API needs a secure context; over
 * plain http this falls back to the classic hidden-textarea trick.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fall through to the textarea fallback
  }
  const previousFocus = document.activeElement as HTMLElement | null;
  const textarea = document.createElement("textarea");
  try {
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-9999px";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    // select() alone does not reliably focus the textarea in every browser.
    textarea.focus();
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
    previousFocus?.focus?.();
  }
}

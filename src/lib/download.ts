// Save text (a log, a JSON export, ...) as a file in the browser.
export const downloadTextFile = (
  filename: string,
  text: string,
  mimeType = "text/plain;charset=utf-8",
) => {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoke on the next tick: some browsers cancel a download whose URL is
  // revoked in the same tick as the click.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
};

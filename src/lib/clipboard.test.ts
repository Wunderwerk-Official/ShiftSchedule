import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "./clipboard";

const setClipboard = (writeText: (text: string) => Promise<void>) => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
};
const setExecCommand = (impl: (command: string) => boolean) => {
  const execCommand = vi.fn(impl);
  Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true });
  return execCommand;
};

describe("copyTextToClipboard", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
    Reflect.deleteProperty(document, "execCommand");
  });

  it("uses the Clipboard API when available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    const execCommand = setExecCommand(() => true);
    await expect(copyTextToClipboard("hello")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(execCommand).not.toHaveBeenCalled();
  });

  it("falls back to execCommand, removes the textarea and restores focus", async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error("insecure context")));
    let copiedText = "";
    setExecCommand((command) => {
      copiedText = (document.activeElement as HTMLTextAreaElement).value;
      return command === "copy";
    });
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();

    await expect(copyTextToClipboard("fallback text")).resolves.toBe(true);
    expect(copiedText).toBe("fallback text");
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("reports failure when execCommand returns false", async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    setExecCommand(() => false);
    await expect(copyTextToClipboard("x")).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports failure when execCommand throws", async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    setExecCommand(() => {
      throw new Error("not supported");
    });
    await expect(copyTextToClipboard("x")).resolves.toBe(false);
    expect(document.querySelector("textarea")).toBeNull();
  });
});

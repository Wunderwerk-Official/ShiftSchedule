import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../api/client";
import LoginPage from "./LoginPage";

const submitWith = async (onLogin: (username: string, password: string) => Promise<void>) => {
  render(<LoginPage onLogin={onLogin} theme="light" onToggleTheme={() => {}} />);
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "anna" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "secret" } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
};

describe("LoginPage", () => {
  it("blames the credentials only for a 401", async () => {
    const onLogin = vi.fn().mockRejectedValue(new HttpError("Failed to login: 401", 401));
    await submitWith(onLogin);
    expect(await screen.findByText(/Check your username and password/)).toBeTruthy();
    expect(onLogin).toHaveBeenCalledWith("anna", "secret");
  });

  it("reports an unreachable server for network errors", async () => {
    await submitWith(vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    expect(await screen.findByText(/Could not reach the server/)).toBeTruthy();
    expect(screen.queryByText(/Check your username and password/)).toBeNull();
  });

  it("reports an unreachable server for 5xx responses (e.g. during a deploy)", async () => {
    await submitWith(vi.fn().mockRejectedValue(new HttpError("Failed to login: 502", 502)));
    expect(await screen.findByText(/Could not reach the server/)).toBeTruthy();
    expect(screen.queryByText(/Check your username and password/)).toBeNull();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "./api/client";

const getCurrentUser = vi.fn();
vi.mock("./api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api/client")>()),
  getCurrentUser: () => getCurrentUser(),
}));
// The schedule page is heavy and irrelevant here; a marker shows it rendered.
vi.mock("./pages/WeeklySchedulePage", () => ({ default: () => <div>schedule page</div> }));

import App from "./App";

describe("App startup auth check", () => {
  beforeEach(() => {
    getCurrentUser.mockReset();
    window.localStorage.setItem("authToken", "valid-token");
  });

  it.each([
    ["a 502 during a deploy restart", new HttpError("Failed to fetch user: 502", 502)],
    ["a network error", new TypeError("fetch failed")],
  ])("keeps the token and offers a retry on %s", async (_label, error) => {
    getCurrentUser.mockRejectedValue(error);
    render(<App />);
    expect(await screen.findByRole("alert")).toHaveTextContent("not reachable");
    expect(screen.queryByRole("heading", { name: "Sign in" })).not.toBeInTheDocument();
    expect(window.localStorage.getItem("authToken")).toBe("valid-token");
  });

  it("signs the user in when the retry succeeds", async () => {
    getCurrentUser
      .mockRejectedValueOnce(new HttpError("Failed to fetch user: 502", 502))
      .mockResolvedValueOnce({ username: "anna", role: "user", active: true });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(await screen.findByText("schedule page")).toBeInTheDocument();
    expect(getCurrentUser).toHaveBeenCalledTimes(2);
  });

  it("still lets the user go to the login page", async () => {
    getCurrentUser.mockRejectedValue(new TypeError("fetch failed"));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Go to sign in" }));
    expect(screen.getByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it.each([401, 403])("clears the token on HTTP %i", async (status) => {
    getCurrentUser.mockRejectedValue(new HttpError(`Failed to fetch user: ${status}`, status));
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(window.localStorage.getItem("authToken")).toBeNull();
  });
});

/**
 * OSLayout.test.jsx
 *
 * Smoke-tests for the overarching OS shell layout and micro-frontend loading.
 */
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { BCIProvider } from "../bci/BCIProvider.jsx";
import OSLayout from "../shell/OSLayout.jsx";

function renderWithBCI(ui) {
  return render(<BCIProvider>{ui}</BCIProvider>);
}

describe("OSLayout", () => {
  it("renders the shell root element", () => {
    renderWithBCI(<OSLayout />);
    expect(screen.getByTestId("os-layout")).toBeTruthy();
  });

  it("renders all three navigation tabs", () => {
    renderWithBCI(<OSLayout />);
    expect(screen.getByTestId("nav-tab-quanttube")).toBeTruthy();
    expect(screen.getByTestId("nav-tab-quantchat")).toBeTruthy();
    expect(screen.getByTestId("nav-tab-quantsink")).toBeTruthy();
  });

  it("shows Quanttube as the default active tab", () => {
    renderWithBCI(<OSLayout />);
    const tab = screen.getByTestId("nav-tab-quanttube");
    expect(tab.getAttribute("aria-selected")).toBe("true");
  });

  it("switches the active tab when a nav tab is clicked", () => {
    renderWithBCI(<OSLayout />);

    fireEvent.click(screen.getByTestId("nav-tab-quantchat"));

    expect(
      screen.getByTestId("nav-tab-quantchat").getAttribute("aria-selected")
    ).toBe("true");
    expect(
      screen.getByTestId("nav-tab-quanttube").getAttribute("aria-selected")
    ).toBe("false");
  });

  it("renders all three MFE wrapper elements (pre-loaded)", () => {
    renderWithBCI(<OSLayout />);
    expect(screen.getByTestId("mfe-wrapper-Quanttube")).toBeTruthy();
    expect(screen.getByTestId("mfe-wrapper-Quantchat")).toBeTruthy();
    expect(screen.getByTestId("mfe-wrapper-Quantsink")).toBeTruthy();
  });

  it("hides inactive MFE wrappers via aria-hidden", () => {
    renderWithBCI(<OSLayout />);

    // Default: Quanttube visible, others hidden
    expect(
      screen.getByTestId("mfe-wrapper-Quanttube").getAttribute("aria-hidden")
    ).toBe("false");
    expect(
      screen.getByTestId("mfe-wrapper-Quantchat").getAttribute("aria-hidden")
    ).toBe("true");
    expect(
      screen.getByTestId("mfe-wrapper-Quantsink").getAttribute("aria-hidden")
    ).toBe("true");
  });

  it("shows the BCI status indicator in the navigation bar", () => {
    renderWithBCI(<OSLayout />);
    // Navigation contains "BCI: idle" by default
    expect(screen.getByText(/BCI: idle/)).toBeTruthy();
  });
});

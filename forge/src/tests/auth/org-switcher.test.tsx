/** @jest-environment jsdom */

import "@testing-library/jest-dom";
import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { OrgSwitcher, OrgSummary } from "@/features/organizations/components/OrgSwitcher";

// Mock next/navigation
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
  }),
}));

describe("OrgSwitcher Component (FC-004)", () => {
  const currentOrg: OrgSummary = {
    id: "org-1",
    name: "Acme Corp",
    slug: "acme-corp",
    role: "ADMIN",
  };

  const organizations: OrgSummary[] = [
    currentOrg,
    {
      id: "org-2",
      name: "Beta Labs",
      slug: "beta-labs",
      role: "MEMBER",
    },
    {
      id: "org-3",
      name: "Gamma Studio",
      slug: "gamma-studio",
      role: "MANAGER",
    },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the current organization name, slug, and role", () => {
    render(
      <OrgSwitcher currentOrg={currentOrg} organizations={organizations} />
    );

    expect(screen.getByText("Acme Corp")).toBeInTheDocument();
    expect(screen.getByText("acme-corp")).toBeInTheDocument();
    expect(screen.getByText("ADMIN")).toBeInTheDocument();
  });

  it("opens the dropdown menu when trigger button is clicked", () => {
    render(
      <OrgSwitcher currentOrg={currentOrg} organizations={organizations} />
    );

    const trigger = screen.getByRole("button", { name: /switch organization/i });
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Workspaces (3)")).toBeInTheDocument();
    expect(screen.getByText("Beta Labs")).toBeInTheDocument();
    expect(screen.getByText("Gamma Studio")).toBeInTheDocument();
    expect(screen.getByText("Create new organization")).toBeInTheDocument();
  });

  it("navigates to the selected organization dashboard when an item is clicked", () => {
    render(
      <OrgSwitcher currentOrg={currentOrg} organizations={organizations} />
    );

    // Open dropdown
    const trigger = screen.getByRole("button", { name: /switch organization/i });
    fireEvent.click(trigger);

    // Click Beta Labs
    const betaButton = screen.getByText("Beta Labs").closest("button");
    expect(betaButton).not.toBeNull();
    fireEvent.click(betaButton!);

    expect(mockPush).toHaveBeenCalledWith("/org/beta-labs/dashboard");
  });

  it("does not navigate if the currently active organization is clicked again", () => {
    render(
      <OrgSwitcher currentOrg={currentOrg} organizations={organizations} />
    );

    const trigger = screen.getByRole("button", { name: /switch organization/i });
    fireEvent.click(trigger);

    // Click Acme Corp (already active)
    const acmeItems = screen.getAllByText("Acme Corp");
    // Item in dropdown is the second one
    const acmeDropdownButton = acmeItems[1].closest("button");
    expect(acmeDropdownButton).not.toBeNull();
    fireEvent.click(acmeDropdownButton!);

    expect(mockPush).not.toHaveBeenCalled();
  });
});

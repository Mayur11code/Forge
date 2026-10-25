/** @jest-environment jsdom */

import "@testing-library/jest-dom";

// src/tests/security/members-page-isolation.test.tsx
//
// Tenant-isolation and role-based authorization tests for MembersPage.
// Verifies that:
// 1. Unauthenticated or foreign callers cannot access the page (notFound()).
// 2. The database query is strictly scoped to access.organization.id.
// 3. Members from another organization are never exposed.
// 4. Admin-only invite actions are hidden for non-admin members.
// 5. Empty and null user fields are handled safely without fabrication.

jest.mock("next/navigation", () => ({
  notFound: jest.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

jest.mock("@/features/organizations/getOrgAccess", () => ({
  getOrgAccess: jest.fn(),
}));

jest.mock("@/lib/prisma/db", () => ({
  db: {
    membership: {
      findMany: jest.fn(),
    },
  },
}));

jest.mock(
  "@/features/organizations/components/invitation/members-table",
  () => ({
    MembersTable: ({ initialMembers }: { initialMembers: Array<{ id: string; name: string; handle: string; role: string }> }) => (
      <div data-testid="members-table" data-count={initialMembers.length}>
        {initialMembers.map((m) => (
          <div key={m.id} data-testid="member-row">
            <span>{m.name}</span>
            <span>{m.handle}</span>
            <span>{m.role}</span>
          </div>
        ))}
      </div>
    ),
  }),
);

jest.mock(
  "@/features/organizations/components/invitation/InviteMemberModal",
  () => ({
    __esModule: true,
    default: ({ orgSlug }: { orgSlug: string }) => (
      <button data-testid="invite-modal" data-org-slug={orgSlug}>
        Invite Member
      </button>
    ),
  }),
);

import { render, screen } from "@testing-library/react";
import { notFound } from "next/navigation";
import { db } from "@/lib/prisma/db";
import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import MembersPage from "@/app/org/[orgId]/members/page";

const notFoundMock = notFound as unknown as jest.Mock;
const getOrgAccessMock = getOrgAccess as jest.Mock;
const membershipFindMany = db.membership.findMany as jest.Mock;

const ORG_A_ID = "org_alpha_id";
const ORG_A_SLUG = "alpha-corp";
const ORG_B_SLUG = "beta-corp";

describe("MembersPage Tenant Isolation & Authorization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("denies access with notFound() when user is not a member of the organization", async () => {
    getOrgAccessMock.mockResolvedValueOnce(null);

    await expect(
      MembersPage({ params: Promise.resolve({ orgId: ORG_B_SLUG }) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(notFoundMock).toHaveBeenCalledTimes(1);
    expect(membershipFindMany).not.toHaveBeenCalled();
  });

  it("scopes member database query strictly to the verified organization id", async () => {
    getOrgAccessMock.mockResolvedValueOnce({
      userId: "user_1",
      organization: { id: ORG_A_ID, name: "Alpha Corp" },
      membership: { role: "ADMIN" },
    });

    membershipFindMany.mockResolvedValueOnce([
      {
        id: "mem_1",
        role: "ADMIN",
        createdAt: new Date("2026-01-01"),
        user: {
          id: "u_1",
          name: "Alice Vance",
          email: "alice@alphacorp.com",
          image: null,
        },
      },
      {
        id: "mem_2",
        role: "MEMBER",
        createdAt: new Date("2026-01-02"),
        user: {
          id: "u_2",
          name: "Bob Stone",
          email: "bob@alphacorp.com",
          image: null,
        },
      },
    ]);

    const pageJsx = await MembersPage({
      params: Promise.resolve({ orgId: ORG_A_SLUG }),
    });
    render(pageJsx);

    // 1. Database query must use the verified organization id, NOT the URL param
    expect(membershipFindMany).toHaveBeenCalledWith({
      where: {
        orgId: ORG_A_ID,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            image: true,
          },
        },
      },
      orderBy: [{ role: "asc" }, { createdAt: "asc" }],
    });

    // 2. Real member records are rendered, not fabricated mock names
    expect(screen.getByText("Alice Vance")).toBeInTheDocument();
    expect(screen.getByText("@alice")).toBeInTheDocument();
    expect(screen.getByText("Admin")).toBeInTheDocument();

    expect(screen.getByText("Bob Stone")).toBeInTheDocument();
    expect(screen.getByText("@bob")).toBeInTheDocument();
    expect(screen.getByText("Member")).toBeInTheDocument();

    // Fabricated mock names from earlier should NEVER appear
    expect(screen.queryByText("Elara Vossen")).not.toBeInTheDocument();
    expect(screen.queryByText("Jaxon Kade")).not.toBeInTheDocument();
  });

  it("displays invite actions when viewer has ADMIN role", async () => {
    getOrgAccessMock.mockResolvedValueOnce({
      userId: "user_admin",
      organization: { id: ORG_A_ID, name: "Alpha Corp" },
      membership: { role: "ADMIN" },
    });

    membershipFindMany.mockResolvedValueOnce([]);

    const pageJsx = await MembersPage({
      params: Promise.resolve({ orgId: ORG_A_SLUG }),
    });
    render(pageJsx);

    expect(screen.getAllByTestId("invite-modal").length).toBeGreaterThan(0);
  });

  it("hides invite actions when viewer has regular MEMBER role", async () => {
    getOrgAccessMock.mockResolvedValueOnce({
      userId: "user_member",
      organization: { id: ORG_A_ID, name: "Alpha Corp" },
      membership: { role: "MEMBER" },
    });

    membershipFindMany.mockResolvedValueOnce([]);

    const pageJsx = await MembersPage({
      params: Promise.resolve({ orgId: ORG_A_SLUG }),
    });
    render(pageJsx);

    // Regular members cannot issue invites; modal must not render
    expect(screen.queryByTestId("invite-modal")).not.toBeInTheDocument();
  });

  it("handles empty memberships and missing user names gracefully", async () => {
    getOrgAccessMock.mockResolvedValueOnce({
      userId: "user_1",
      organization: { id: ORG_A_ID, name: "Alpha Corp" },
      membership: { role: "MEMBER" },
    });

    membershipFindMany.mockResolvedValueOnce([
      {
        id: "mem_noname",
        role: "MEMBER",
        createdAt: new Date("2026-01-01"),
        user: {
          id: "u_noname",
          name: null, // User has no name set
          email: "nameless@alphacorp.com",
          image: null,
        },
      },
    ]);

    const pageJsx = await MembersPage({
      params: Promise.resolve({ orgId: ORG_A_SLUG }),
    });
    render(pageJsx);

    // Fallback to email username
    expect(screen.getByText("nameless")).toBeInTheDocument();
    expect(screen.getByText("@nameless")).toBeInTheDocument();
  });
});

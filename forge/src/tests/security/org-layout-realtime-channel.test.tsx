/** @jest-environment jsdom */

// The organization layout must resolve the URL slug to the persisted
// organization first, then pass that persisted id to the realtime subscriber.
// If it passes the slug, the client listens on a channel the worker never
// publishes to.

jest.mock("next/navigation", () => ({
  notFound: jest.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

jest.mock("@/features/organizations/getOrgAccess", () => ({
  getOrgAccess: jest.fn(),
}));

jest.mock("@/contexts/OrgContext", () => ({
  OrgProvider: ({
    children,
    orgSlug,
  }: {
    children: React.ReactNode;
    orgSlug: string;
  }) => (
    <div data-testid="org-provider" data-org-slug={orgSlug}>
      {children}
    </div>
  ),
}));

jest.mock(
  "@/features/organizations/components/pusher/RealtimeListener",
  () => ({
    RealtimeListener: ({
      organizationId,
    }: {
      organizationId: string;
    }) => (
      <div
        data-testid="realtime-listener"
        data-organization-id={organizationId}
      />
    ),
  }),
);

jest.mock("@/features/organizations/components/Sidebar", () => ({
  Sidebar: ({ orgId }: { orgId: string }) => (
    <div data-testid="sidebar" data-org-id={orgId} />
  ),
}));

import { render, screen } from "@testing-library/react";

import { getOrgAccess } from "@/features/organizations/getOrgAccess";
import OrgLayout from "@/app/org/[orgId]/layout";

const getOrgAccessMock = getOrgAccess as jest.Mock;

const SLUG = "acme";
const ORGANIZATION_ID = "clx_org_a";

beforeEach(() => {
  jest.clearAllMocks();
  getOrgAccessMock.mockResolvedValue({
    userId: "clx_user_a",
    organization: { id: ORGANIZATION_ID },
    membership: { role: "MEMBER" },
  });
});

it("subscribes with the persisted organization id, not the URL slug", async () => {
  const tree = await OrgLayout({
    children: <div>child</div>,
    params: Promise.resolve({ orgId: SLUG }),
  });

  render(tree);

  expect(getOrgAccessMock).toHaveBeenCalledWith(SLUG);
  expect(
    screen
      .getByTestId("realtime-listener")
      .getAttribute("data-organization-id"),
  ).toBe(ORGANIZATION_ID);
  expect(
    screen.getByTestId("org-provider").getAttribute("data-org-slug"),
  ).toBe(SLUG);
  expect(screen.getByTestId("sidebar").getAttribute("data-org-id")).toBe(
    SLUG,
  );
});

it("does not mount the realtime listener without organization access", async () => {
  getOrgAccessMock.mockResolvedValue(null);

  await expect(
    OrgLayout({
      children: <div>child</div>,
      params: Promise.resolve({ orgId: SLUG }),
    }),
  ).rejects.toThrow("NEXT_NOT_FOUND");
});

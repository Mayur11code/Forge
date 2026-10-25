jest.mock("@/lib/prisma/db", () => ({
  db: {
    membership: {
      findUnique: jest.fn(),
    },
  },
}));

jest.mock("@/lib/emails/core-service", () => ({
  executeSendEmail: jest.fn(),
}));

jest.mock("@/lib/pusher/pusher-server", () => ({
  pusherServer: {
    trigger: jest.fn(),
  },
}));

import { db } from "@/lib/prisma/db";
import { executeSendEmail } from "@/lib/emails/core-service";
import { pusherServer } from "@/lib/pusher/pusher-server";
import { organizationChannelName } from "@/lib/pusher/org-channel";
import { emailWorkerHandler } from "@/app/api/worker/email-worker/ew";

const membershipFindUniqueMock = db.membership.findUnique as jest.Mock;
const executeSendEmailMock = executeSendEmail as jest.Mock;
const pusherTriggerMock = pusherServer.trigger as jest.Mock;

const ORG_A = "org_a";
const ORG_B = "org_b";
const USER_ID = "user_a";
const RECIPIENT = "member@example.com";

const event = {
  id: "event_1",
  type: "SEND_EMAIL" as const,
  time: "2026-10-22T00:00:00.000Z",
  data: {
    orgId: ORG_A,
    userId: USER_ID,
    subject: "New Task Created",
    body: 'A new task "Onboard Acme Enterprise" has been added.',
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  membershipFindUniqueMock.mockResolvedValue({
    user: { email: RECIPIENT },
  });
  executeSendEmailMock.mockResolvedValue({
    id: "email_1",
    deliveredTo: RECIPIENT,
  });
  pusherTriggerMock.mockResolvedValue(undefined);
});

describe("SEND_EMAIL recipient resolution", () => {
  it("delivers to the event user's email when that user is a member of the event organization", async () => {
    await emailWorkerHandler({ event });

    expect(membershipFindUniqueMock).toHaveBeenCalledWith({
      where: {
        userId_orgId: {
          userId: USER_ID,
          orgId: ORG_A,
        },
      },
      select: {
        user: {
          select: {
            email: true,
          },
        },
      },
    });
    expect(executeSendEmailMock).toHaveBeenCalledWith({
      to: RECIPIENT,
      subject: "New Task Created",
      html: expect.stringContaining(
        'A new task "Onboard Acme Enterprise" has been added.',
      ),
    });
    expect(pusherTriggerMock).toHaveBeenCalledWith(
      organizationChannelName(ORG_A),
      "job-completed",
      { message: expect.any(String) },
    );
  });

  it("ignores fixed or client-smuggled recipient fields on the event", async () => {
    const smuggledEvent = {
      ...event,
      data: {
        ...event.data,
        to: "attacker@example.com",
        recipient: "attacker@example.com",
        email: "attacker@example.com",
      },
    } as unknown as typeof event;

    await emailWorkerHandler({ event: smuggledEvent });

    expect(executeSendEmailMock).toHaveBeenCalledTimes(1);
    expect(executeSendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: RECIPIENT }),
    );
    expect(executeSendEmailMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: "attacker@example.com" }),
    );
  });

  it("fails closed without sending when the user is not a member of the event organization", async () => {
    membershipFindUniqueMock.mockResolvedValue(null);

    await expect(
      emailWorkerHandler({
        event: {
          ...event,
          data: { ...event.data, orgId: ORG_B },
        },
      }),
    ).rejects.toThrow(
      "SEND_EMAIL could not resolve a deliverable member recipient",
    );

    expect(executeSendEmailMock).not.toHaveBeenCalled();
    expect(pusherTriggerMock).not.toHaveBeenCalled();
  });

  it("fails closed without sending when the member email is invalid", async () => {
    membershipFindUniqueMock.mockResolvedValue({
      user: { email: "not-an-email" },
    });

    await expect(emailWorkerHandler({ event })).rejects.toThrow(
      "SEND_EMAIL could not resolve a deliverable member recipient",
    );

    expect(executeSendEmailMock).not.toHaveBeenCalled();
    expect(pusherTriggerMock).not.toHaveBeenCalled();
  });

  it("fails closed for the task.create producer's synthetic system-cdc actor", async () => {
    membershipFindUniqueMock.mockResolvedValue(null);

    await expect(
      emailWorkerHandler({
        event: {
          ...event,
          data: { ...event.data, userId: "system-cdc" },
        },
      }),
    ).rejects.toThrow(
      "SEND_EMAIL could not resolve a deliverable member recipient",
    );

    expect(executeSendEmailMock).not.toHaveBeenCalled();
  });

  it("fails closed for the cron fallback's synthetic system actor", async () => {
    membershipFindUniqueMock.mockResolvedValue(null);

    await expect(
      emailWorkerHandler({
        event: {
          ...event,
          data: { ...event.data, userId: "system" },
        },
      }),
    ).rejects.toThrow(
      "SEND_EMAIL could not resolve a deliverable member recipient",
    );

    expect(executeSendEmailMock).not.toHaveBeenCalled();
  });

  it("fails closed when the event has no recipient identity", async () => {
    membershipFindUniqueMock.mockResolvedValue(null);

    await expect(
      emailWorkerHandler({
        event: {
          ...event,
          data: { ...event.data, userId: undefined },
        } as unknown as typeof event,
      }),
    ).rejects.toThrow(
      "SEND_EMAIL could not resolve a deliverable member recipient",
    );

    expect(executeSendEmailMock).not.toHaveBeenCalled();
  });

  it("never falls back to the previous fixed personal address", async () => {
    membershipFindUniqueMock.mockResolvedValue(null);

    await expect(emailWorkerHandler({ event })).rejects.toThrow();

    expect(executeSendEmailMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ to: "mayurnanda45@gmail.com" }),
    );
  });
});

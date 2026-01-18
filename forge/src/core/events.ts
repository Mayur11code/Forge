import { z } from "zod";

const TaskCreatedSchema = z.discriminatedUnion("event", [
    z.object({
        event: z.literal("TASK_CREATED"),
        payload: z.object({
            taskId: z.uuid(),
            creatorId: z.uuid()
        })
    }),
    z.object({
        event: z.literal("MEMBER_INVITED"),
        payload: z.object({
            email: z.string().email(),
            inviterId: z.string().uuid()
        })
    }),
    z.object({
        event: z.literal("ORG_DELETED"),
        payload: z.object({
            orgId: z.string().uuid(),
            reason: z.string().min(10)
        })
    })
]);


type ForgeEvent = z.infer<typeof TaskCreatedSchema>;

function processEvent(event: ForgeEvent) {
    switch (event.event) {
        case "TASK_CREATED":
            console.log(`Task created with ID: ${event.payload.taskId} by user: ${event.payload.creatorId}`);
            break;
        case "MEMBER_INVITED":
            console.log(`Member invited with email: ${event.payload.email} by user: ${event.payload.inviterId}`);
            break;
        case "ORG_DELETED":
            console.log(`Organization deleted with ID: ${event.payload.orgId} for reason: ${event.payload.reason}`);
            break;
        default:
            const _exhaustiveCheck: never = event;
            return _exhaustiveCheck;
    
    }
}   

const sampleEvent: ForgeEvent = {
    event: "TASK_CREATED",
    payload: { taskId: "123e4567-e89b-12d3-a456-426614174000", creatorId: "987e6543-e21b-12d3-a456-426614174000" }
};  
processEvent(sampleEvent);
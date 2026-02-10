// import { notFound } from "next/navigation";
// import { auth } from "@/lib/auth/auth";
// import { db } from "@/lib/prisma/db";


// export async function requireOrgAccess(orgId: string) {
//   // 1️⃣ Authenticate user
// const session = await auth();
//   console.log("Session in Org Settings Page:", session?.user.id);

//   if (!session?.user?.id) {
//     notFound();
//   }

 

//   const userId = session.user.id;

//   // 2️⃣ Fetch organization
//   const organization = await db.organization.findUnique({
//     where: {
//     //   id: orgId, ==> gives error, ebcause findUnique needs unique field
//       slug: orgId,
//     },
//     select: {
//       id: true,
//       name: true,
//     },
//   });

//   console.log("Organization fetched:", organization);

//   if (!organization) {
//     notFound();
//   }

//   // 3️⃣ Fetch membership (read-level authorization)
// const membership = await db.membership.findUnique({
//   where: {
//     userId_orgId: {
//       userId,
//       orgId: organization.id,
//     },
//   },
//   select: {
//     role: true,
//   },
// });


//   // 4️⃣ Block cross-tenant access
//   if (!membership) {
//     notFound();
//   }

//     return { organization, membership };
// } 



//Depreciated: This function will be replaced by getOrgAccess,
//  which is more versatile and can be used in more places across the codebase.
// The getOrgAccess function will return null if the user is not authenticated or if they do not have access to the organization.
// Otherwise, it will return an object containing the userId, organization details, and membership details.
// We will replace requireOrgAccess with getOrgAccess slowly in the codebase, and we will update the places where requireOrgAccess is used to use getOrgAccess instead.
// Currently I made this for uploadThing, which is a new feature that allows users to upload files to the server.
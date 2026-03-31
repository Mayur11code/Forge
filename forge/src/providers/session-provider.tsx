"use client";

import { SessionProvider } from "next-auth/react";

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  return <SessionProvider>{children}</SessionProvider>;
};


//This is for the next-auth session provider, which allows us to access the user's session throughout the app.
//Why did i add this ? Because we need to access the user's session in various parts of the app, such as when we want to display the user's name or profile picture, or when we want to check if the user is logged in before allowing them to access certain pages. By wrapping our app in the SessionProvider, we can easily access the user's session using the useSession hook from next-auth.
//is it necessary to have this ? Yes, if you want to use next-auth for authentication in your app, you need to have the SessionProvider to provide the session context to your components. Without it, you won't be able to access the user's session and authentication state throughout your app.
import { LoginFormComponent } from "./login-form";

export default async function LoginPage(params: Promise<{orgId?: string}>) {
  const { orgId } = await params;
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50">
      
       

        {/* The Actual Form Logic */}
        <LoginFormComponent  />

        

      
    </div>
  );
}
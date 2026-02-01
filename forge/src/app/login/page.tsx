import { LoginFormComponent } from "./login-form";

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full p-8 bg-white rounded-xl shadow-lg border border-gray-100">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-gray-900">Welcome Back</h1>
          <p className="text-gray-500 mt-2">Sign in to your organization dashboard</p>
        </div>

        {/* The Actual Form Logic */}
        <LoginFormComponent />

        <div className="mt-6 text-center text-sm text-gray-500">
          Don't have an account?{" "}
          <a href="/register" className="text-blue-600 hover:underline font-medium">
            Create one for free
          </a>
        </div>
      </div>
    </div>
  );
}
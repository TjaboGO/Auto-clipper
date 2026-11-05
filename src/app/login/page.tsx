import { Suspense } from 'react';
import { LoginForm } from './LoginForm';

export const metadata = { title: 'Logga in · Auto Clipper' };

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}

import { redirect } from 'next/navigation';
import { auth, signOut } from '@/lib/auth';
import Link from 'next/link';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session) {
    redirect('/login');
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-card border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex justify-between items-center h-16">
            <div className="flex items-center gap-8">
              <Link href="/" className="text-xl font-serif font-bold text-foreground">
                Stratos
              </Link>
              <nav className="hidden md:flex gap-6">
                <Link
                  href="/takeoff"
                  className="text-muted-foreground hover:text-foreground font-medium transition-smooth"
                >
                  Takeoff
                </Link>
                <Link
                  href="/bids"
                  className="text-muted-foreground hover:text-foreground font-medium transition-smooth"
                >
                  Bids
                </Link>
                <Link
                  href="/connections"
                  className="text-muted-foreground hover:text-foreground font-medium transition-smooth"
                >
                  Connections
                </Link>
              </nav>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-muted-foreground">
                {session.user?.email}
              </span>
              <form
                action={async () => {
                  'use server';
                  await signOut({ redirectTo: '/login' });
                }}
              >
                <button
                  type="submit"
                  className="text-sm text-muted-foreground hover:text-foreground transition-smooth"
                >
                  Sign out
                </button>
              </form>
            </div>
          </div>
        </div>
      </header>

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {children}
      </main>
    </div>
  );
}

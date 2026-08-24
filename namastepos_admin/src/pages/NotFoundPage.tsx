// NamastePOS admin — 404 page.
//
// Same idea as the customer dashboard: a real "not found" instead of
// silently redirecting to the platform overview.

import { Link, useLocation } from 'react-router-dom';
import { Home, Compass } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function NotFoundPage() {
  const loc = useLocation();
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="max-w-md w-full text-center space-y-4">
        <div className="mx-auto w-16 h-16 rounded-full bg-muted grid place-items-center">
          <Compass className="w-8 h-8 text-muted-foreground" />
        </div>
        <h1 className="text-3xl font-bold">Page not found</h1>
        <p className="text-muted-foreground">
          No admin page at <code className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{loc.pathname}</code>.
        </p>
        <div className="flex justify-center gap-2 pt-2">
          <Button asChild>
            <Link to="/"><Home className="mr-2 h-4 w-4" /> Back to Dashboard</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}

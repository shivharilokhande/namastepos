// NamastePOS dashboard — banner shown when a super admin is impersonating a customer.
//
// Detects impersonation by inspecting the JWT (imp: true). Shows a sticky
// warning bar at the top of every page with a one-click exit button.

import { Eye, X } from 'lucide-react';
import { isImpersonating, exitImpersonation, getBusinessCache } from '@/api/client';

export function ImpersonationBanner() {
  if (!isImpersonating()) return null;
  const biz = getBusinessCache();

  return (
    <div className="sticky top-0 z-50 bg-amber-500 text-amber-950 border-b border-amber-700 shadow-md">
      <div className="container mx-auto py-2 px-4 flex items-center justify-between gap-3 text-sm">
        <div className="flex items-center gap-2 font-semibold">
          <Eye className="h-4 w-4" />
          <span>
            Impersonating <strong>{biz?.name || 'a customer'}</strong> · super-admin session
          </span>
        </div>
        <button
          onClick={exitImpersonation}
          className="flex items-center gap-1.5 bg-amber-950 text-amber-100 px-3 py-1.5 rounded-md text-xs font-semibold hover:bg-amber-900 transition-colors"
        >
          <X className="h-3 w-3" /> Exit impersonation
        </button>
      </div>
    </div>
  );
}
